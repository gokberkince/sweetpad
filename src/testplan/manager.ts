import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ExtensionContext } from "../common/commands";
import { EventEmitter } from "events";
import { getWorkspacePath } from "../build/utils";

export type TestPlanType = "smoke" | "regression" | "snapshot" | "unit" | "event";
export type TestPlanConfiguration = {
  id: string;
  name: string;
  options: {
    region?: string;
    language?: string;
    environmentVariableEntries?: Array<{ key: string; value: string }>;
  };
};

export type TestPlan = {
  path: string;
  type: TestPlanType;
  name: string;
  configurations: TestPlanConfiguration[];
  testTarget?: string;
};

export class TestPlansManager extends EventEmitter {
  private _context?: ExtensionContext;
  private _testPlans: TestPlan[] = [];
  private _selectedTestPlan?: TestPlan;

  constructor() {
    super();
  }

  set context(context: ExtensionContext) {
    this._context = context;
  }

  get testPlans(): TestPlan[] {
    return this._testPlans;
  }

  get selectedTestPlan(): TestPlan | undefined {
    return this._selectedTestPlan;
  }

  private getTestPlanType(planPath: string): TestPlanType {
    // Extract the type from the path structure (e.g., UITests/TestPlans/RegressionTestPlans/...)
    const normalizedPath = planPath.replace(/\\/g, '/'); // Normalize path separators
    const pathParts = normalizedPath.split('/');
    
    // Find the part that contains "TestPlans"
    for (const part of pathParts) {
      if (part.includes('SmokeTestPlans')) return 'smoke';
      if (part.includes('RegressionTestPlans')) return 'regression';
      if (part.includes('SnapshotTestPlans')) return 'snapshot';
      if (part.includes('UnitTestPlans')) return 'unit';
      if (part.includes('EventTestPlans')) return 'event';
    }
    
    return 'unit'; // default
  }

  setSelectedTestPlan(testPlan: TestPlan | undefined) {
    if (this._selectedTestPlan?.path === testPlan?.path) return; // Don't emit if same plan
    this._selectedTestPlan = testPlan;
    this.emit("selectedTestPlanChanged", testPlan);
    this.emit("testPlansChanged"); // Also emit this to refresh the tree view
  }

  getSelectedTestPlan(): TestPlan | undefined {
    return this._selectedTestPlan;
  }

  async refresh() {
    if (!this._context) return;
    const workspacePath = getWorkspacePath();
    if (!workspacePath) return;

    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Fetching Test Plans",
      cancellable: false
    }, async (progress) => {
      // Get the selected scheme from build manager
      const selectedScheme = this._context!.buildManager.getDefaultSchemeForBuild();
      if (!selectedScheme) {
        this._testPlans = [];
        this.emit("testPlansChanged");
        return;
      }

      progress.report({ message: "Finding scheme file..." });

      // Try to find scheme file in both xcodeproj and xcworkspace
      let schemeContent: string | undefined;
      let schemeFilePath: string | undefined;

      // First try xcodeproj
      const xcodeprojMatches = await vscode.workspace.findFiles(
        `**/*.xcodeproj/xcshareddata/xcschemes/${selectedScheme}.xcscheme`
      );
      
      // If not found in xcodeproj, try xcworkspace
      const xcworkspaceMatches = await vscode.workspace.findFiles(
        `**/*.xcworkspace/xcshareddata/xcschemes/${selectedScheme}.xcscheme`
      );

      // Use the first match found
      const matchedFile = xcodeprojMatches[0] || xcworkspaceMatches[0];
      if (matchedFile) {
        schemeFilePath = matchedFile.fsPath;
        schemeContent = fs.readFileSync(schemeFilePath, 'utf-8');
      }

      if (!schemeContent || !schemeFilePath) {
        this._testPlans = [];
        this.emit("testPlansChanged");
        return;
      }

      progress.report({ message: "Parsing test plan references..." });

      // First find the TestPlans section
      const testPlansSection = schemeContent.match(/<TestPlans>([\s\S]*?)<\/TestPlans>/)?.[1];
      if (!testPlansSection) {
        this._testPlans = [];
        this.emit("testPlansChanged");
        vscode.window.showInformationMessage("No TestPlans section found in the scheme");
        return;
      }

      // Parse XML to get test plan references
      const testPlans: TestPlan[] = [];
      const testPlanMatches = testPlansSection.match(/<TestPlanReference[^>]*?>/g);
      
      if (testPlanMatches) {
        let processedCount = 0;
        const totalCount = testPlanMatches.length;

        for (const match of testPlanMatches) {
          processedCount++;
          progress.report({ 
            message: `Loading test plans (${processedCount}/${totalCount})...`,
            increment: (1 / totalCount) * 100
          });

          const reference = match.match(/reference\s*=\s*"([^"]*)"/)?.[1];
          const isDefault = match.includes('default = "YES"');
          
          if (reference && reference.startsWith('container:')) {
            // Convert container:path to absolute path
            const relativePath = reference.replace('container:', '');
            const planPath = path.join(workspacePath, relativePath);

            if (!fs.existsSync(planPath)) {
              continue;
            }

            try {
              const content = fs.readFileSync(planPath, 'utf-8');
              const testPlanData = JSON.parse(content);
              const name = path.basename(planPath, '.xctestplan');
              
              // Determine type from the path
              const type = this.getTestPlanType(planPath);
              
              testPlans.push({
                path: planPath,
                type: type,
                name: name,
                configurations: testPlanData.configurations || [],
                testTarget: testPlanData.testTarget
              });

              // If this is the default test plan and we don't have a selected plan yet, select it
              if (isDefault && !this._selectedTestPlan) {
                this.setSelectedTestPlan(testPlans[testPlans.length - 1]);
              }
            } catch (error) {
              console.error(`Error reading test plan at ${planPath}:`, error);
            }
          }
        }
      }

      this._testPlans = testPlans;
      
      // If the previously selected test plan is no longer available, clear it
      if (this._selectedTestPlan && !testPlans.find(tp => tp.path === this._selectedTestPlan?.path)) {
        this.setSelectedTestPlan(undefined);
      }
      
      this.emit("testPlansChanged");

      // Show summary
      if (testPlans.length > 0) {
        vscode.window.showInformationMessage(`Found ${testPlans.length} test plans`);
      } else {
        vscode.window.showInformationMessage("No test plans found in the selected scheme");
      }
    });
  }

  async runTests(testPlan: TestPlan, configuration?: string, withoutBuilding: boolean = false) {
    if (!this._context) return;
    
    const args = [
      "test-without-building",
      "-testPlan", testPlan.name
    ];

    if (configuration) {
      args.push("-only-test-configuration", configuration);
    }

    // Add the command execution logic here using the context
    // this._context.buildManager.runXcodebuildCommand(args);
  }
} 