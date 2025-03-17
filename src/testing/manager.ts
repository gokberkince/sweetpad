import path from "node:path";
import * as vscode from "vscode";
import { getXcodeBuildDestinationString } from "../build/commands.js";
import { askXcodeWorkspacePath, getWorkspacePath } from "../build/utils.js";
import { getBuildSettingsOptional } from "../common/cli/scripts.js";
import type { ExtensionContext } from "../common/commands.js";
import { errorReporting } from "../common/error-reporting.js";
import { exec } from "../common/exec.js";
import { isFileExists } from "../common/files.js";
import { commonLogger } from "../common/logger.js";
import { runTask } from "../common/tasks.js";
import type { Destination } from "../destination/types.js";
import { askConfigurationForTesting, askDestinationToTestOn, askSchemeForTesting, askTestingTarget, askTestPlan, askTestPlanConfiguration } from "./utils";

type TestingInlineError = {
  fileName: string;
  lineNumber: number;
  message: string;
};

/**
 * Track the result of each `xcodebuild` test run — which tests have been processed, failed and so on.
 *
 * - methodTestId: the test method ID in the format "ClassName.methodName"
 */
class XcodebuildTestRunContext {
  private processedMethodTests = new Set<string>();
  protected failedMethodTests = new Set<string>();
  private inlineErrorMap = new Map<string, TestingInlineError>();
  private methodTests: Map<string, vscode.TestItem>;

  constructor(options: {
    methodTests: Iterable<[string, vscode.TestItem]>;
  }) {
    this.methodTests = new Map(options.methodTests);
  }

  getMethodTest(methodTestId: string): vscode.TestItem | undefined {
    return this.methodTests.get(methodTestId);
  }

  addProcessedMethodTest(methodTestId: string): void {
    this.processedMethodTests.add(methodTestId);
  }

  addFailedMethodTest(methodTestId: string): void {
    this.failedMethodTests.add(methodTestId);
  }

  addInlineError(methodTestId: string, error: TestingInlineError): void {
    this.inlineErrorMap.set(methodTestId, error);
  }

  getInlineError(methodTestId: string): TestingInlineError | undefined {
    return this.inlineErrorMap.get(methodTestId);
  }

  isMethodTestProcessed(methodTestId: string): boolean {
    return this.processedMethodTests.has(methodTestId);
  }

  getUnprocessedMethodTests(): vscode.TestItem[] {
    return [...this.methodTests.values()].filter((test) => !this.processedMethodTests.has(test.id));
  }

  getOverallStatus(): "passed" | "failed" | "skipped" {
    // Some tests failed
    if (this.failedMethodTests.size > 0) {
      return "failed";
    }

    // All tests passed
    if (this.processedMethodTests.size === this.methodTests.size) {
      return "passed";
    }

    // Some tests are still unprocessed
    return "skipped";
  }

  getTestIds(): string[] {
    return Array.from(this.methodTests.keys());
  }

  findTestIdByMethodName(methodName: string): string | undefined {
    return this.getTestIds().find(id => id.endsWith(`.${methodName}`));
  }

  hasFailedMethodTest(methodTestId: string): boolean {
    return this.failedMethodTests.has(methodTestId);
  }
}

/**
 * Extracts a code block from the given text starting from the given index.
 *
 * TODO: use a proper Swift parser to find code blocks
 */
function extractCodeBlock(text: string, startIndex: number): string | null {
  let braceCount = 0;
  let inString = false;
  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];
    if (char === '"' || char === "'") {
      inString = !inString;
    } else if (!inString) {
      if (char === "{") {
        braceCount++;
      } else if (char === "}") {
        braceCount--;
        if (braceCount === 0) {
          return text.substring(startIndex, i + 1);
        }
      }
    }
  }
  return null;
}

/**
 * Get all ancestor paths of a childPath that are within the parentPath (including the parentPath).
 */
function* getAncestorsPaths(options: {
  parentPath: string;
  childPath: string;
}): Generator<string> {
  const { parentPath, childPath } = options;

  if (!childPath.startsWith(parentPath)) {
    return;
  }

  let currentPath = path.dirname(childPath);
  while (currentPath !== parentPath) {
    yield currentPath;
    currentPath = path.dirname(currentPath);
  }
  yield parentPath;
}

/*
 * Custom data for test items
 */
type TestItemContext = {
  type: "class" | "method";
  spmTarget?: string;
};

export class TestingManager {
  readonly controller: vscode.TestController;
  private _context: ExtensionContext | undefined;
  private _currentTestId: string | undefined;

  // Inline error messages, usually is between "passed" and "failed" lines. Seems like only macOS apps have this line.
  // Example output:
  // "/Users/username/Projects/ControlRoom/ControlRoomTests/SimCtlSubCommandsTests.swift:10: error: -[ControlRoomTests.SimCtlSubCommandsTests testDeleteUnavailable] : failed: caught "NSInternalInconsistencyException", "Failed to delete unavailable device with UDID '00000000-0000-0000-0000-000000000000'."
  // "/Users/hyzyla/Developer/sweetpad-examples/ControlRoom/ControlRoomTests/Controllers/SimCtl+SubCommandsTests.swift:76: error: -[ControlRoomTests.SimCtlSubCommandsTests testDefaultsForApp] : XCTAssertEqual failed: ("1") is not equal to ("2")"
  // {filePath}:{lineNumber}: error: -[{classAndTargetName} {methodName}] : {errorMessage}
  readonly INLINE_ERROR_REGEXP = /(.*):(\d+): error: -\[.* (.*)\] : (.*)/;

  // Find test method status lines
  // Example output:
  // "Test Case '-[ControlRoomTests.SimCtlSubCommandsTests testDeleteUnavailable]' started."
  // "Test Case '-[ControlRoomTests.SimCtlSubCommandsTests testDeleteUnavailable]' passed (0.001 seconds)."
  // "Test Case '-[ControlRoomTests.SimCtlSubCommandsTests testDeleteUnavailable]' failed (0.001 seconds).")
  readonly METHOD_STATUS_REGEXP_MACOS = /Test Case '-\[(.*) (.*)\]' (.*)/;

  // "Test case 'terminal23TesMakarenko1ts.testExample1()' failed on 'Clone 1 of iPhone 14 - terminal23 (27767)' (0.154 seconds)"
  // "Test case 'terminal23TesMakarenko1ts.testExample2()' passed on 'Clone 1 of iPhone 14 - terminal23 (27767)' (0.000 seconds)"
  // "Test case 'terminal23TesMakarenko1ts.testPerformanceExample()' passed on 'Clone 1 of iPhone 14 - terminal23 (27767)' (0.254 seconds)"
  readonly METHOD_STATUS_REGEXP_IOS = /Test case '(.*)\.(.*)\(\)' (.*)/;

  // Here we are storign additional data for test items. Weak map garanties that we
  // don't keep the items in memory if they are not used anymore
  readonly testItems = new WeakMap<vscode.TestItem, TestItemContext>();

  // Root folder of the workspace (VSCode, not Xcode)
  readonly workspacePath: string;
  
  // Debounce timer for document changes
  private documentChangeDebounceTimer: NodeJS.Timeout | undefined;
  
  // Store disposables to clean up when the manager is disposed
  private disposables: vscode.Disposable[] = [];

  // Context key for BaseTest inheritance
  private static readonly BASE_TEST_CONTEXT_KEY = 'sweetpad.testing.isBaseTest';

  /**
   * Check if a document contains any class that inherits from BaseTest
   */
  private async hasBaseTestClass(document: vscode.TextDocument): Promise<boolean> {
    const text = document.getText();
    const classRegex = /class\s+(\w+)\s*:\s*([^{]+)/g;
    
    while (true) {
      const classMatch = classRegex.exec(text);
      if (classMatch === null) {
        break;
      }
      
      const inheritanceList = classMatch[2].split(',').map(s => s.trim());
      if (inheritanceList.some(base => base === 'BaseTest')) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Update the BaseTest context key for the given document
   */
  private async updateBaseTestContext(document: vscode.TextDocument | undefined) {
    if (!document || !document.uri.path.endsWith('.swift')) {
      await vscode.commands.executeCommand('setContext', TestingManager.BASE_TEST_CONTEXT_KEY, false);
      return;
    }

    const hasBaseTest = await this.hasBaseTestClass(document);
    await vscode.commands.executeCommand('setContext', TestingManager.BASE_TEST_CONTEXT_KEY, hasBaseTest);
  }

  constructor() {
    this.workspacePath = getWorkspacePath();

    this.controller = vscode.tests.createTestController("uitests", "Trendyol");

    // Update context when active editor changes
    const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(editor => {
      this.updateBaseTestContext(editor?.document);
    });

    // Register document listeners
    const documentAddRemoveListener = vscode.workspace.onDidSaveTextDocument(async document => {
      // Only process Swift files
      if (!document.uri.path.endsWith('.swift')) {
        return;
      }
      
      // Update context for the saved document
      await this.updateBaseTestContext(document);
      
      // Check if the file contains any BaseTest classes
      const hasBaseTest = await this.hasBaseTestClass(document);
      if (!hasBaseTest) {
        return;
      }
      
      // Since we're only running on save, we don't need debouncing anymore
      // but we'll keep it just in case multiple save events happen in quick succession
      if (this.documentChangeDebounceTimer) {
        clearTimeout(this.documentChangeDebounceTimer);
      }
      
      this.documentChangeDebounceTimer = setTimeout(() => {
        this.discoverUITests();
      }, 100); // Reduced debounce time since saves are less frequent than changes
    });
    
    // Watch for file system changes (creation/deletion of Swift files)
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.swift');
    
    // When a new Swift file is created, check if it contains BaseTest classes
    const fileCreateListener = fileWatcher.onDidCreate(async uri => {
      const document = await vscode.workspace.openTextDocument(uri);
      await this.updateBaseTestContext(document);
      const hasBaseTest = await this.hasBaseTestClass(document);
      if (hasBaseTest) {
        this.discoverUITests();
      }
    });
    
    // When a Swift file is deleted, rediscover tests
    const fileDeleteListener = fileWatcher.onDidDelete(() => {
      this.discoverUITests();
    });
    
    // Store disposables for cleanup
    this.disposables.push(
      activeEditorListener,
      documentAddRemoveListener,
      fileWatcher,
      fileCreateListener,
      fileDeleteListener
    );

    // Register editor title button for Swift files
    vscode.commands.registerCommand('sweetpad.testing.refreshCurrentDocument', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.path.endsWith('.swift')) {
        const hasBaseTest = await this.hasBaseTestClass(editor.document);
        if (hasBaseTest) {
          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Refreshing UI Tests",
            cancellable: false
          }, async () => {
            await this.discoverUITests();
          });
        }
      }
    });

    // Initialize context for current editor
    this.updateBaseTestContext(vscode.window.activeTextEditor?.document);

    // Create run profile
    this.controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, async (request, token) => {
      await this.buildAndRunTests(request, token);
    }, true);

    // Create run without building profile
    this.controller.createRunProfile("Run (without building)", vscode.TestRunProfileKind.Run, async (request, token) => {
      await this.runTestsWithoutBuilding(request, token);
    }, false);

    // Discover UI tests in UITests folder
        // Discover UI tests in UITests folder with notification
        Promise.resolve().then(async () => {
          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Discovering UI Tests",
            cancellable: false
          }, async () => {
            await this.discoverUITests();
          });
        }).catch(error => {
          console.error('Failed to discover UI tests:', error);
        });
  }

  private async discoverUITests() {
    const uiTestsPath = path.join(this.workspacePath, 'UITests');
    const testFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(uiTestsPath, '**/*.swift')
    );

    // Create domain groups
    const domainGroups = new Map<string, vscode.TestItem>();
    const testTypeGroups = new Map<string, Map<string, vscode.TestItem>>();

    // Clear existing items before starting discovery
    this.controller.items.replace([]);

    // Process each test file
    for (const file of testFiles) {
      const relativePath = path.relative(uiTestsPath, file.fsPath);
      const parts = relativePath.split(path.sep);
      
      // Skip if not in the expected structure
      if (parts.length < 3) continue;

      const [domain, testType] = parts;

      // Create domain group if it doesn't exist
      if (!domainGroups.has(domain)) {
        const domainItem = this.controller.createTestItem(
          domain,
          domain,
          vscode.Uri.file(path.join(uiTestsPath, domain))
        );
        domainGroups.set(domain, domainItem);
        
        // Initialize test type map for this domain
        testTypeGroups.set(domain, new Map());
      }

      // Get the test types map for this domain
      const domainTestTypes = testTypeGroups.get(domain)!;

      // Create test type group if it doesn't exist
      if (!domainTestTypes.has(testType)) {
        const testTypeItem = this.controller.createTestItem(
          `${domain}:${testType}`,
          testType,
          vscode.Uri.file(path.join(uiTestsPath, domain, testType))
        );
        domainTestTypes.set(testType, testTypeItem);
        
        // Add test type group to domain group
        const domainGroup = domainGroups.get(domain)!;
        const existingDomainChildren = domainGroup.children ? Array.from(domainGroup.children).map(([_, item]) => item) : [];
        if (!existingDomainChildren.some(child => child.id === testTypeItem.id)) {
          domainGroup.children?.replace([...existingDomainChildren, testTypeItem]);
        }
      }

      // Parse the test file content
      const document = await vscode.workspace.openTextDocument(file);
      const text = document.getText();

      // Regex to find classes inheriting from BaseTest or multiple inheritance including BaseTest
      const classRegex = /class\s+(\w+)\s*:\s*([^{]+)/g;
      while (true) {
        const classMatch = classRegex.exec(text);
        if (classMatch === null) {
          break;
        }

        const className = classMatch[1];
        const inheritanceList = classMatch[2].split(',').map(s => s.trim());
        
        // Check if the class inherits from BaseTest
        if (!inheritanceList.some(base => base === 'BaseTest')) {
          continue;
        }

        const classStartIndex = classMatch.index + classMatch[0].length;
        const classPosition = document.positionAt(classMatch.index);

        const classTestItem = this.controller.createTestItem(
          `${domain}:${testType}:${className}`,
          className,
          document.uri
        );
        classTestItem.range = new vscode.Range(classPosition, classPosition);
        this.testItems.set(classTestItem, { type: 'class' });

        const classCode = extractCodeBlock(text, classStartIndex - 1); // Start from '{'

        if (classCode === null) {
          continue; // Could not find class code block
        }

        // Find all test methods within the class
        const funcRegex = /func\s+(test\w+)\s*\(/g;

        while (true) {
          const funcMatch = funcRegex.exec(classCode);
          if (funcMatch === null) {
            break;
          }
          const testName = funcMatch[1];
          const testStartIndex = classStartIndex + funcMatch.index;
          const position = document.positionAt(testStartIndex);

          const testItem = this.controller.createTestItem(
            `${domain}:${testType}:${className}.${testName}`,
            testName,
            document.uri
          );

          testItem.range = new vscode.Range(position, position);
          this.testItems.set(testItem, { type: 'method' });
          classTestItem.children?.add(testItem);
        }

        // Add test class to test type group
        const testTypeGroup = domainTestTypes.get(testType)!;
        const existingTests = testTypeGroup.children ? Array.from(testTypeGroup.children).map(([_, item]) => item) : [];
        if (!existingTests.some(test => test.id === classTestItem.id)) {
          testTypeGroup.children?.replace([...existingTests, classTestItem]);
        }
      }
    }

    // Add all domain groups to the test controller
    this.controller.items.replace([...domainGroups.values()]);
  }

  /**
   * Create run profile for the test controller with proper error handling
   */
  createRunProfile(options: {
    name: string;
    kind: vscode.TestRunProfileKind;
    isDefault?: boolean;
    run: (request: vscode.TestRunRequest, token: vscode.CancellationToken) => Promise<void>;
  }) {
    this.controller.createRunProfile(
      options.name,
      options.kind,
      async (request, token) => {
        try {
          return await options.run(request, token);
        } catch (error) {
          const errorMessage: string =
            error instanceof Error ? error.message : (error?.toString() ?? "[unknown error]");
          commonLogger.error(errorMessage, {
            error: error,
          });
          errorReporting.captureException(error);
          throw error;
        }
      },
      options.isDefault,
    );
  }

  set context(context: ExtensionContext) {
    this._context = context;
  }

  get context(): ExtensionContext {
    if (!this._context) {
      throw new Error("Context is not set");
    }
    return this._context;
  }

  dispose() {
    this.controller.dispose();
    
    // Dispose all registered disposables
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    
    // Clear any pending debounce timer
    if (this.documentChangeDebounceTimer) {
      clearTimeout(this.documentChangeDebounceTimer);
      this.documentChangeDebounceTimer = undefined;
    }
  }

  setDefaultTestingTarget(target: string | undefined) {
    this.context.updateWorkspaceState("testing.xcodeTarget", target);
  }

  getDefaultTestingTarget(): string | undefined {
    return this.context.getWorkspaceState("testing.xcodeTarget");
  }

  /**
   * Create a new test item for the given document with additional context data
   */
  createTestItem(options: {
    id: string;
    label: string;
    uri: vscode.Uri;
    type: TestItemContext["type"];
  }): vscode.TestItem {
    const testItem = this.controller.createTestItem(options.id, options.label, options.uri);
    this.testItems.set(testItem, {
      type: options.type,
    });
    return testItem;
  }

  /**
   * Find all test methods in the given document and update the test items in test controller
   *
   * TODO: use a proper Swift parser to find test methods
   */
  updateTestItems(document: vscode.TextDocument) {
    // Skip non-swift files
    if (!document.uri.path.endsWith(".swift")) {
      return;
    }

    // Remove existing test items for this document
    for (const [id, testItem] of this.controller.items) {
      if (testItem.uri?.toString() === document.uri.toString()) {
        this.controller.items.delete(id);
      }
    }

    const text = document.getText();

    // Regex to find classes inheriting from BaseTest or multiple inheritance including BaseTest
    const classRegex = /class\s+(\w+)\s*:\s*([^{]+)/g;
    while (true) {
      const classMatch = classRegex.exec(text);
      if (classMatch === null) {
        break;
      }

      const className = classMatch[1];
      const inheritanceList = classMatch[2].split(',').map(s => s.trim());
      
      // Check if the class inherits from BaseTest
      if (!inheritanceList.some(base => base === 'BaseTest')) {
        continue;
      }

      const classStartIndex = classMatch.index + classMatch[0].length;
      const classPosition = document.positionAt(classMatch.index);

      const classTestItem = this.createTestItem({
        id: className,
        label: className,
        uri: document.uri,
        type: "class",
      });
      classTestItem.range = new vscode.Range(classPosition, classPosition);
      this.controller.items.add(classTestItem);

      const classCode = extractCodeBlock(text, classStartIndex - 1); // Start from '{'

      if (classCode === null) {
        continue; // Could not find class code block
      }

      // Find all test methods within the class
      const funcRegex = /func\s+(test\w+)\s*\(/g;

      while (true) {
        const funcMatch = funcRegex.exec(classCode);
        if (funcMatch === null) {
          break;
        }
        const testName = funcMatch[1];
        const testStartIndex = classStartIndex + funcMatch.index;
        const position = document.positionAt(testStartIndex);

        const testItem = this.createTestItem({
          id: `${className}.${testName}`,
          label: testName,
          uri: document.uri,
          type: "method",
        });

        testItem.range = new vscode.Range(position, position);
        classTestItem.children?.add(testItem);
      }
    }
  }

  /**
   * Ask common configuration options for running tests
   */
  async askTestingConfigurations(): Promise<{
    xcworkspace: string;
    scheme: string;
    configuration: string;
    testConfiguration?: string;
    destination: Destination;
  }> {
    // todo: consider to have separate configuration for testing and building. currently we use the
    // configuration for building the project

    const xcworkspace = await askXcodeWorkspacePath(this.context);
    const scheme = await askSchemeForTesting(this.context, {
      xcworkspace: xcworkspace,
      title: "Select a scheme to run tests",
    });

    // Get test plans from TestPlansManager
    let configuration = "Debug"; // Default
    let testConfiguration: string | undefined; // For test plan configuration
    
    if (this.context?.testPlansManager) {
      const testPlansManager = this.context.testPlansManager;
      let selectedTestPlan = testPlansManager.selectedTestPlan;
      
      // If no test plan is selected or we want to ask anyway, show the test plan picker
      if (!selectedTestPlan || true) { // Always ask for now
        const testPlans = testPlansManager.testPlans;
        if (testPlans.length > 0) {
          const testPlanItem = await askTestPlan(this.context, {
            title: "Select a test plan",
            testPlans: testPlans
          });
          
          if (testPlanItem) {
            selectedTestPlan = testPlanItem;
            testPlansManager.setSelectedTestPlan(selectedTestPlan);
          }
        }
      }

      // Get configuration from test plan if available
      if (selectedTestPlan && selectedTestPlan.configurations.length > 0) {
        // Add "All Regions" option
        const allRegionsOption = {
          label: "All Regions",
          description: "Run tests for all regions",
          config: undefined
        };
        
        const configItems = [
          allRegionsOption,
          ...selectedTestPlan.configurations.map(config => ({
            label: config.name,
            description: config.options.region ? `Region: ${config.options.region}` : undefined,
            config
          }))
        ];
        
        const selectedItem = await vscode.window.showQuickPick(configItems, {
          placeHolder: "Select a configuration or All Regions"
        });
        
        if (selectedItem && selectedItem.config) {
          // Only set testConfiguration if a specific config was selected (not All Regions)
          testConfiguration = selectedItem.config.name;
          configuration = "Debug"; // Default for test plans
        }
      } else {
        // Fallback to asking for configuration directly
        configuration = await askConfigurationForTesting(this.context, {
          xcworkspace: xcworkspace,
        });
      }
    } else {
      // Fallback if no test plans manager
      configuration = await askConfigurationForTesting(this.context, {
        xcworkspace: xcworkspace,
      });
    }

    const buildSettings = await getBuildSettingsOptional({
      scheme: scheme,
      configuration: configuration,
      sdk: undefined,
      xcworkspace: xcworkspace,
    });
    const destination = await askDestinationToTestOn(this.context, buildSettings);
    return {
      xcworkspace: xcworkspace,
      scheme: scheme,
      configuration: configuration,
      testConfiguration,
      destination: destination,
    };
  }

  /**
   * Execute separate command to build the project before running tests
   */
  async buildForTestingCommand() {
    // For direct build calls, we don't need test plans or configurations
    // Just get the basic build settings
    const xcworkspace = await askXcodeWorkspacePath(this.context);
    const scheme = await askSchemeForTesting(this.context, {
      xcworkspace: xcworkspace,
      title: "Select a scheme to build",
    });

    const buildSettings = await getBuildSettingsOptional({
      scheme: scheme,
      configuration: "Debug", // Use Debug as default for building
      sdk: undefined,
      xcworkspace: xcworkspace,
    });

    const destination = await askDestinationToTestOn(this.context, buildSettings);

    // Call buildForTesting with isDirectBuild flag
    await this.buildForTesting({
      destination: destination,
      scheme: scheme,
      xcworkspace: xcworkspace,
      isDirectBuild: true
    });
  }

  /**
   * Build the project for testing
   */
  async buildForTesting(options: {
    scheme: string;
    destination: Destination;
    xcworkspace: string;
    isDirectBuild?: boolean;
  }) {
    const destinationRaw = getXcodeBuildDestinationString({ destination: options.destination });

    // Base arguments for xcodebuild
    const xcodebuildArgs = [
      "build-for-testing",
      "-workspace", options.xcworkspace,
      "-scheme", options.scheme,
      "-destination", destinationRaw,
    ];

    // Add configuration (Debug is default for building)
    xcodebuildArgs.push("-configuration", "Debug");

    // Add allowProvisioningUpdates only for direct builds
    // For test-related builds, this will be handled by the test runner
    if (options.isDirectBuild) {
      xcodebuildArgs.push("-allowProvisioningUpdates");
    }

    await runTask(this.context, {
      name: "sweetpad.build.build",
      lock: "sweetpad.build",
      terminateLocked: true,
      callback: async (terminal) => {
        await terminal.execute({
          command: "xcodebuild",
          args: xcodebuildArgs,
        });
      },
    });
  }

  /**
   * Extract error message from the test output and prepare vscode TestMessage object
   * to display it in the test results.
   */
  getMethodError(options: {
    methodTestId: string;
    runContext: XcodebuildTestRunContext;
  }) {
    const { methodTestId, runContext } = options;

    // Inline error message are usually before the "failed" line
    const error = runContext.getInlineError(methodTestId);
    if (error) {
      // detailed error message with location
      const testMessage = new vscode.TestMessage(error.message);
      testMessage.location = new vscode.Location(
        vscode.Uri.file(error.fileName),
        new vscode.Position(error.lineNumber - 1, 0),
      );
      return testMessage;
    }

    // just geeric error message, no error location or details
    // todo: parse .xcresult file to get more detailed error message
    return new vscode.TestMessage("Test failed (error message is not extracted).");
  }

  /**
   * Parse each line of the `xcodebuild` output to update the test run
   * with the test status and any inline error messages.
   */
  async parseOutputLine(options: {
    line: string;
    className: string;
    testRun: vscode.TestRun;
    runContext: XcodebuildTestRunContext;
  }) {
    const { testRun, className, runContext } = options;
    const line = options.line.trim();

    const methodStatusMatchIOS = line.match(this.METHOD_STATUS_REGEXP_IOS);
    if (methodStatusMatchIOS) {
      const [, , methodName, status] = methodStatusMatchIOS;
      // Find the full test ID by searching through the available method tests
      const methodTestId = runContext.findTestIdByMethodName(methodName);
      if (!methodTestId) return;

      const methodTest = runContext.getMethodTest(methodTestId);
      if (!methodTest) return;

      if (status.startsWith("started")) {
        testRun.started(methodTest);
      } else if (status.startsWith("passed")) {
        if (runContext.hasFailedMethodTest(methodTestId)) {
          console.log(`Test ${methodTestId} failed initially but passed on rerun.`);
          // Optionally, you can add this to a separate set for flaky tests
        }
        testRun.passed(methodTest);
        runContext.addProcessedMethodTest(methodTestId);
      } else if (status.startsWith("failed")) {
        const error = this.getMethodError({
          methodTestId: methodTestId,
          runContext: runContext,
        });
        testRun.failed(methodTest, error);
        runContext.addProcessedMethodTest(methodTestId);
        runContext.addFailedMethodTest(methodTestId);
      }
      return;
    }

    const methodStatusMatchMacOS = line.match(this.METHOD_STATUS_REGEXP_MACOS);
    if (methodStatusMatchMacOS) {
      const [, , methodName, status] = methodStatusMatchMacOS;
      // Find the full test ID by searching through the available method tests
      const methodTestId = runContext.findTestIdByMethodName(methodName);
      if (!methodTestId) return;

      const methodTest = runContext.getMethodTest(methodTestId);
      if (!methodTest) return;

      if (status.startsWith("started")) {
        testRun.started(methodTest);
      } else if (status.startsWith("passed")) {
        if (runContext.hasFailedMethodTest(methodTestId)) {
          console.log(`Test ${methodTestId} failed initially but passed on rerun.`);
          // Optionally, you can add this to a separate set for flaky tests
        }
        testRun.passed(methodTest);
        runContext.addProcessedMethodTest(methodTestId);
      } else if (status.startsWith("failed")) {
        const error = this.getMethodError({
          methodTestId: methodTestId,
          runContext: runContext,
        });
        testRun.failed(methodTest, error);
        runContext.addProcessedMethodTest(methodTestId);
        runContext.addFailedMethodTest(methodTestId);
      }
      return;
    }

    const inlineErrorMatch = line.match(this.INLINE_ERROR_REGEXP);
    if (inlineErrorMatch) {
      const [, filePath, lineNumber, methodName, errorMessage] = inlineErrorMatch;
      // Find the full test ID by searching through the available method tests
      const testId = runContext.findTestIdByMethodName(methodName);
      if (!testId) return;

      runContext.addInlineError(testId, {
        fileName: filePath,
        lineNumber: Number.parseInt(lineNumber, 10),
        message: errorMessage,
      });
      return;
    }
  }

  /**
   * Get list of method tests that should be runned
   */
  prepareQueueForRun(request: vscode.TestRunRequest): vscode.TestItem[] {
    const queue: vscode.TestItem[] = [];

    if (request.include) {
      // all tests selected by the user
      queue.push(...request.include);
    } else {
      // all root test items
      queue.push(...[...this.controller.items].map(([, item]) => item));
    }

    // when class test is runned, all its method tests are runned too, so we need to filter out
    // methods that should be runned as part of class test
    return queue.filter((test) => {
      const [className, methodName] = test.id.split(".");
      if (!methodName) return true;
      return !queue.some((t) => t.id === className);
    });
  }

  /**
   * For SPM packages we need to resolve the target name for the test file
   * from the Package.swift file. For some reason it doesn't use the target name
   * from xcode project
   */
  async resolveSPMTestingTarget(options: {
    queue: vscode.TestItem[];
    xcworkspace: string;
  }) {
    const { queue, xcworkspace } = options;
    const workscePath = getWorkspacePath();

    // Cache for resolved target names. Example:
    // - /folder1/folder2/Tests/MyAppTests -> ""
    // - /folder1/folder2/Tests -> ""
    // - /folder1/folder2 -> "MyAppTests"
    const pathCache = new Map<string, string>();

    for (const test of queue) {
      const testPath = test.uri?.fsPath;
      if (!testPath) {
        continue;
      }

      // In general all should have context, but check just in case
      const testContext = this.testItems.get(test);
      if (!testContext) {
        continue;
      }

      // Iterate over all ancestors of the test file path to find SPM file
      // Example:
      // /folder1/folder2/folder3/Tests/MyAppTests/MyAppTests.swift
      // /folder1/folder2/folder3/Tests/MyAppTests/
      // /folder1/folder2/folder3/Tests
      // /folder1/folder2/folder3
      for (const ancestorPath of getAncestorsPaths({
        parentPath: workscePath,
        childPath: testPath,
      })) {
        const cachedTarget = pathCache.get(ancestorPath);
        if (cachedTarget !== undefined) {
          // path doesn't have "Package.swift" file, so move to the next ancestor
          if (cachedTarget === "") {
            continue;
          }
          testContext.spmTarget = cachedTarget;
        }

        const packagePath = path.join(ancestorPath, "Package.swift");
        const isPackageExists = await isFileExists(packagePath);
        if (!isPackageExists) {
          pathCache.set(ancestorPath, "");
          continue;
        }

        // stop search and try to get the target name from "Package.swift" file
        try {
          const stdout = await exec({
            command: "swift",
            args: ["package", "dump-package"],
            cwd: ancestorPath,
          });
          const stdoutJson = JSON.parse(stdout);

          const targets = stdoutJson.targets;
          const testTargetNames = targets
            ?.filter((target: any) => target.type === "test")
            .filter((target: any) => {
              const targetPath = target.path
                ? path.join(ancestorPath, target.path)
                : path.join(ancestorPath, "Tests", target.name);
              return testPath.startsWith(targetPath);
            })
            .map((target: any) => target.name);

          if (testTargetNames.length === 1) {
            const testTargetName = testTargetNames[0];
            pathCache.set(ancestorPath, testTargetName);
            testContext.spmTarget = testTargetName;
            return testTargetName;
          }
        } catch (error) {
          // In case of error, we assume that the target name is is name name of test folder:
          // - Tests/{targetName}/{testFile}.swift
          commonLogger.error("Failed to get test target name", {
            error: error,
          });

          const relativePath = path.relative(ancestorPath, testPath);
          const match = relativePath.match(/^Tests\/([^/]+)/);
          if (match) {
            const testTargetName = match[1];
            pathCache.set(ancestorPath, testTargetName);
            testContext.spmTarget = testTargetName;
            return match[1];
          }
        }

        // Package.json exists but we failed to get the target name, let's move on to the next ancestor
        pathCache.set(ancestorPath, "");
        break;
      }
    }
  }

  /**
   * Run selected tests after prepraration and configuration
   */
  async runTests(options: {
    request: vscode.TestRunRequest;
    run: vscode.TestRun;
    xcworkspace: string;
    destination: Destination;
    scheme: string;
    token: vscode.CancellationToken;
    command?: string;
    configuration?: string;
    testConfiguration?: string;
  }) {
    const { xcworkspace, scheme, token, run, request, destination, command, configuration, testConfiguration } = options;

    const queue = this.prepareQueueForRun(request);
    
    // Filter out invalid test items (like parent folders)
    const validTests = queue.filter(test => this.isValidTestItem(test));
    if (validTests.length === 0) {
      return;
    }

    // Store the first test's ID if available (for batch execution)
    if (validTests.length > 1) {
      this.setCurrentTestId(validTests[0].id);
    }

    await this.resolveSPMTestingTarget({
      queue: queue,
      xcworkspace: xcworkspace,
    });

    try {
      commonLogger.debug("Running tests", {
        scheme: scheme,
        xcworkspace: xcworkspace,
        tests: queue.map((test) => test.id),
      });

      // If only one test is selected, use the specific test runner for better handling
      if (validTests.length === 1) {
        const test = validTests[0];
        const testContext = this.testItems.get(test);
        
        if (!testContext) {
          run.skipped(test);
          return;
        }

        if (testContext.type === "method") {
          await this.runMethodTest({
            run,
            methodTest: test,
            xcworkspace,
            scheme,
            destination,
            defaultTarget: null,
            configuration,
            testConfiguration,
            command
          });
        } else if (testContext.type === "class") {
          await this.runClassTest({
            run,
            classTest: test,
            xcworkspace,
            scheme,
            destination,
            defaultTarget: null,
            configuration,
            testConfiguration,
            command
          });
        }
        return;
      }

      // Multiple tests selected - use batch execution
      const allMethodTests = new Map<string, vscode.TestItem>();
      const testSpecs: string[] = [];
      
      for (const test of validTests) {
        if (token.isCancellationRequested) {
          run.skipped(test);
          continue;
        }

        const parts = test.id.split(':');
        const testTarget = this.getTestTarget(test.id);
        
        if (!testTarget) {
          run.skipped(test);
          continue;
        }

        if (test.id.includes(".")) {
          // Method test
          const [domain, testType, classAndMethod] = parts;
          const [className, methodName] = classAndMethod.split('.');
          testSpecs.push(`${testTarget}/${className}/${methodName}`);
          allMethodTests.set(test.id, test);
          run.started(test);
        } else if (parts.length === 2) {
          // Test type selected (e.g., "Meal:SmokeTests")
          testSpecs.push(testTarget);
          run.started(test);
          
          // Add all classes and their methods under this test type
          if (test.children) {
            for (const [_, classTest] of test.children) {
              run.started(classTest);
              if (classTest.children) {
                for (const [id, methodTest] of classTest.children) {
                  allMethodTests.set(id, methodTest);
                  run.started(methodTest);
                }
              }
            }
          }
        } else {
          // Class test
          const [domain, testType, className] = parts;
          testSpecs.push(`${testTarget}/${className}`);
          run.started(test);
          
          // Add all method tests from the class
          if (test.children) {
            for (const [id, methodTest] of test.children) {
              allMethodTests.set(id, methodTest);
              run.started(methodTest);
            }
          }
        }
      }

      // Get destination string
      const destinationRaw = getXcodeBuildDestinationString({ destination });
      
      // Base command arguments
      const xcodebuildArgs = [
        command || "test", // Respect provided command (test/test-without-building)
        "-workspace", xcworkspace,
        "-scheme", scheme,
        "-destination", destinationRaw,
      ];
      
      // Add configuration (use provided or default to Debug)
      xcodebuildArgs.push("-configuration", configuration || "Debug");

      // Add allowProvisioningUpdates for build-related commands
      if (command?.includes("build")) {
        xcodebuildArgs.push("-allowProvisioningUpdates");
      }
      
      // Use the selected test plan from TestPlansManager
      const testPlan = this.context?.testPlansManager?.selectedTestPlan;
      if (testPlan) {
        xcodebuildArgs.push("-testPlan", testPlan.name);
        
        // Add test configuration only if a specific one is selected
        if (testPlan.configurations && testPlan.configurations.length > 0) {
          // Check if a specific configuration was selected
          const selectedConfig = testPlan.configurations.find(config => 
            testConfiguration && config.name === testConfiguration
          );
          
          if (selectedConfig) {
            xcodebuildArgs.push("-only-test-configuration", selectedConfig.name);
          }
        }
      }
      
      // Add all test specifications
      for (const testSpec of testSpecs) {
        xcodebuildArgs.push("-only-testing", testSpec);
      }

      const runContext = new XcodebuildTestRunContext({
        methodTests: allMethodTests,
      });

      try {
        await runTask(this.context, {
          name: "sweetpad.testing.runTest",
          lock: "sweetpad.build",
          terminateLocked: true,
          callback: async (terminal) => {
            await terminal.execute({
              command: "xcodebuild",
              args: xcodebuildArgs,
              onOutputLine: async (output) => {
                await this.parseOutputLine({
                  line: output.value,
                  testRun: run,
                  className: "", // Not needed when running multiple tests
                  runContext: runContext,
                });
              },
            });
          },
        });
      } catch (error) {
        console.error("Tests failed due to an error", error);
        // Handle any errors during test execution
        const errorMessage = `Tests failed due to an error: ${error instanceof Error ? error.message : "Tests failed"}`;
        
        // Mark all unprocessed tests as failed
        for (const test of validTests) {
          if (!runContext.isMethodTestProcessed(test.id)) {
            run.failed(test, new vscode.TestMessage(errorMessage));
          }
        }
      } finally {
        // Mark any unprocessed tests as skipped
        for (const [id, test] of allMethodTests) {
          if (!runContext.isMethodTestProcessed(id)) {
            run.skipped(test);
          }
        }
      }
    } finally {
      // Clear the current test ID after tests are run
      this.setCurrentTestId(undefined);
    }
  }

  /**
   * Run selected tests without building the project
   * This is faster but you may need to build manually before running tests
   */
  async runTestsWithoutBuilding(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    const queue = this.prepareQueueForRun(request);
    
    // Filter out invalid test items (like parent folders)
    const validTests = queue.filter(test => this.isValidTestItem(test));
    if (validTests.length === 0) {
      return;
    }

    // Store the first test's ID if available
    if (validTests.length > 0) {
      this.setCurrentTestId(validTests[0].id);
    }

    const run = this.controller.createTestRun(request);
    try {
      const { scheme, destination, xcworkspace, configuration, testConfiguration } = await this.askTestingConfigurations();

      await this.runTests({
        run: run,
        request: request,
        xcworkspace: xcworkspace,
        destination: destination,
        scheme: scheme,
        token: token,
        command: "test-without-building",
        testConfiguration
      });
    } finally {
      // Clear the current test ID
      this.setCurrentTestId(undefined);
      run.end();
    }
  }

  /**
   * Build the project and run the selected tests
   */
  async buildAndRunTests(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    const queue = this.prepareQueueForRun(request);
    
    // Filter out invalid test items (like parent folders)
    const validTests = queue.filter(test => this.isValidTestItem(test));
    if (validTests.length === 0) {
      return;
    }

    const { xcworkspace, scheme, configuration, testConfiguration, destination } = await this.askTestingConfigurations();
    // Test plan is already selected in askTestingConfigurations

    // Build for testing first (without isDirectBuild flag since this is part of test execution)
    await this.buildForTesting({
      destination,
      scheme,
      xcworkspace,
      isDirectBuild: false
    });

    // Run tests
    const run = this.controller.createTestRun(request);

    // Run each test
    for (const test of validTests) {
      const testContext = this.testItems.get(test);
      if (!testContext) {
        continue;
      }

      if (testContext.type === "method") {
        await this.runMethodTest({
          run,
          methodTest: test,
          xcworkspace,
          scheme,
          destination,
          defaultTarget: null,
          configuration,
          testConfiguration,
          command: "test-without-building"
        });
      } else if (testContext.type === "class") {
        await this.runClassTest({
          run,
          classTest: test,
          xcworkspace,
          scheme,
          destination,
          defaultTarget: null,
          configuration,
          testConfiguration,
          command: "test-without-building"
        });
      }
    }

    run.end();
  }

  getTestTarget(testId: string): string | undefined {
    // Extract domain and test type from the test ID
    const parts = testId.split(':');
    if (parts.length >= 2) {
      const [domain, testType] = parts;
      // For test category (e.g., RegressionTests), construct target name
      if (domain && testType && testType.endsWith('Tests')) {
        // If we have exactly 2 parts, it means we selected the test type itself
        // Example: "Meal:SmokeTests" -> "MealSmokeTests"
        if (parts.length === 2) {
          return `${domain}${testType}`;
        }
        // For class or method tests, still return the same target
        // Example: "Meal:SmokeTests:TestClass" -> "MealSmokeTests"
        // Example: "Meal:SmokeTests:TestClass.testMethod" -> "MealSmokeTests"
        return `${domain}${testType}`;
      }
    }
    return undefined;
  }

  private isValidTestItem(test: vscode.TestItem): boolean {
    const parts = test.id.split(':');
    // Show buttons for:
    // - Test types (e.g., Meal:SmokeTests)
    // - Test classes (e.g., Meal:SmokeTests:TestClass)
    // - Test methods (e.g., Meal:SmokeTests:TestClass.testMethod)
    return parts.length >= 2 && parts[1].endsWith('Tests');
  }

  async runMethodTest(options: {
    run: vscode.TestRun;
    methodTest: vscode.TestItem;
    xcworkspace: string;
    scheme: string;
    destination: Destination;
    defaultTarget: string | null;
    configuration?: string;
    testConfiguration?: string;
    command?: string;
  }): Promise<void> {
    const { run, methodTest, xcworkspace, scheme, destination } = options;

    // Store the current test ID
    this.setCurrentTestId(methodTest.id);

    try {
      // Extract class name and method name from the test ID
      const parts = methodTest.id.split(':');
      const [domain, testType, classAndMethod] = parts;
      const [className, methodName] = classAndMethod.split('.');
      const testTarget = this.getTestTarget(methodTest.id);

      // Skip if no valid test target
      if (!testTarget) {
        run.skipped(methodTest);
        return;
      }

      // Use the selected test plan from TestPlansManager
      const testPlan = this.context?.testPlansManager?.selectedTestPlan;
      
      // Get destination string
      const destinationRaw = getXcodeBuildDestinationString({ destination });
      
      // Command arguments
      const xcodebuildArgs = [
        options.command || "test",
        "-workspace", xcworkspace,
        "-scheme", scheme,
        "-destination", destinationRaw,
      ];
      
      // Add configuration (use provided or default to Debug)
      xcodebuildArgs.push("-configuration", options.configuration || "Debug");
      
      // Add test plan if available
      if (testPlan) {
        xcodebuildArgs.push("-testPlan", testPlan.name);
        
        // Add test configuration only if a specific one is selected
        if (testPlan.configurations && testPlan.configurations.length > 0) {
          // Check if a specific configuration was selected
          const selectedConfig = testPlan.configurations.find(config => 
            options.testConfiguration && config.name === options.testConfiguration
          );
          
          if (selectedConfig) {
            xcodebuildArgs.push("-only-test-configuration", selectedConfig.name);
          }
        }
      }
      
      // Add test target
      xcodebuildArgs.push("-only-testing", `${testTarget}/${className}/${methodName}`);

      const runContext = new XcodebuildTestRunContext({
        methodTests: [[methodTest.id, methodTest]],
      });

      run.started(methodTest);

    try {
      await runTask(this.context, {
          name: "sweetpad.testing.runTest",
        lock: "sweetpad.build",
        terminateLocked: true,
        callback: async (terminal) => {
          await terminal.execute({
            command: "xcodebuild",
            args: xcodebuildArgs,
            onOutputLine: async (output) => {
              await this.parseOutputLine({
                line: output.value,
                testRun: run,
                className: className,
                runContext: runContext,
              });
            },
          });
        },
      });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Test failed";
        run.failed(methodTest, new vscode.TestMessage(errorMessage));
    } finally {
        if (!runContext.isMethodTestProcessed(methodTest.id)) {
        run.skipped(methodTest);
      }
      }
    } finally {
      // Clear the current test ID
      this.setCurrentTestId(undefined);
    }
  }

  async runClassTest(options: {
    run: vscode.TestRun;
    classTest: vscode.TestItem;
    xcworkspace: string;
    scheme: string;
    destination: Destination;
    defaultTarget: string | null;
    configuration?: string;
    testConfiguration?: string;
    command?: string;
  }): Promise<void> {
    const { run, classTest, xcworkspace, scheme, destination } = options;

    // Store the current test ID
    this.setCurrentTestId(classTest.id);

    try {
      // Extract class name from the test ID
      const parts = classTest.id.split(':');
      const [domain, testType, className] = parts;
      const testTarget = this.getTestTarget(classTest.id);

      // Skip if no valid test target
      if (!testTarget) {
        run.skipped(classTest);
        return;
      }

      // Use the selected test plan from TestPlansManager
      const testPlan = this.context?.testPlansManager?.selectedTestPlan;
      
      // Get destination string
      const destinationRaw = getXcodeBuildDestinationString({ destination });
      
      // Command arguments
      const xcodebuildArgs = [
        options.command || "test",
        "-workspace", xcworkspace,
        "-scheme", scheme,
        "-destination", destinationRaw,
      ];
      
      // Add configuration (use provided or default to Debug)
      xcodebuildArgs.push("-configuration", options.configuration || "Debug");
      
      // Add test plan if available
      if (testPlan) {
        xcodebuildArgs.push("-testPlan", testPlan.name);
        
        // Add test configuration only if a specific one is selected
        if (testPlan.configurations && testPlan.configurations.length > 0) {
          // Check if a specific configuration was selected
          const selectedConfig = testPlan.configurations.find(config => 
            options.testConfiguration && config.name === options.testConfiguration
          );
          
          if (selectedConfig) {
            xcodebuildArgs.push("-only-test-configuration", selectedConfig.name);
          }
        }
      }
      
      // Add test target
      xcodebuildArgs.push("-only-testing", `${testTarget}/${className}`);

      const methodTests = new Map<string, vscode.TestItem>();
      if (classTest.children) {
        for (const [id, test] of classTest.children) {
          methodTests.set(id, test);
        }
      }

      const runContext = new XcodebuildTestRunContext({
        methodTests,
      });

      run.started(classTest);

      try {
    await runTask(this.context, {
          name: "sweetpad.testing.runTest",
      lock: "sweetpad.build",
      terminateLocked: true,
      callback: async (terminal) => {
          await terminal.execute({
            command: "xcodebuild",
            args: xcodebuildArgs,
            onOutputLine: async (output) => {
              await this.parseOutputLine({
                line: output.value,
                  testRun: run,
                className: className,
                runContext: runContext,
                });
              },
              });
            },
          });
        } catch (error) {
        console.error("Test class failed due to an error", error);
        // Handle any errors during test execution
        const errorMessage = `Test class failed due to an error: ${error instanceof Error ? error.message : "Test failed"}`;
        run.failed(classTest, new vscode.TestMessage(errorMessage));

        // Mark all unprocessed child tests as failed
        for (const methodTest of runContext.getUnprocessedMethodTests()) {
          run.failed(methodTest, new vscode.TestMessage("Test failed due to an error."));
        }
        } finally {
        // Mark any unprocessed tests as skipped
        for (const methodTest of runContext.getUnprocessedMethodTests()) {
          run.skipped(methodTest);
        }

        // Determine the overall status of the test class
        const overallStatus = runContext.getOverallStatus();
        if (overallStatus === "failed") {
          run.failed(classTest, new vscode.TestMessage("One or more tests failed."));
        } else if (overallStatus === "passed") {
          run.passed(classTest);
        } else if (overallStatus === "skipped") {
          run.skipped(classTest);
        }
      }
    } finally {
      // Clear the current test ID
      this.setCurrentTestId(undefined);
    }
  }

  getCurrentTestId(): string | undefined {
    return this._currentTestId;
  }

  setCurrentTestId(testId: string | undefined) {
    this._currentTestId = testId;
  }
}
