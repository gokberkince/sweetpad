import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ExtensionContext } from "../common/commands";
import { EventEmitter } from "events";
import { getWorkspacePath } from "../build/utils";

export type TestPlanType = "smoke" | "regression" | "snapshot" | "unit";
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
};

export class TestPlansManager extends EventEmitter {
  private _context?: ExtensionContext;
  private _testPlans: TestPlan[] = [];

  constructor() {
    super();
  }

  set context(context: ExtensionContext) {
    this._context = context;
  }

  get testPlans(): TestPlan[] {
    return this._testPlans;
  }

  private getTestPlanType(folderPath: string): TestPlanType {
    if (folderPath.includes("SmokeTestPlans")) return "smoke";
    if (folderPath.includes("RegressionTestPlans")) return "regression";
    if (folderPath.includes("SnapshotTestPlans")) return "snapshot";
    if (folderPath.includes("UnitTestPlans")) return "unit";
    return "unit"; // default
  }

  async refresh() {
    if (!this._context) return;
    const workspacePath = getWorkspacePath();
    if (!workspacePath) return;

    const testPlansPath = path.join(workspacePath, "UITests", "TestPlans");
    if (!fs.existsSync(testPlansPath)) return;

    const testPlans: TestPlan[] = [];
    const testPlanFolders = ["SmokeTestPlans", "RegressionTestPlans", "SnapshotTestPlans", "UnitTestPlans"];

    for (const folder of testPlanFolders) {
      const folderPath = path.join(testPlansPath, folder);
      if (!fs.existsSync(folderPath)) continue;

      const files = fs.readdirSync(folderPath);
      for (const file of files) {
        if (!file.endsWith(".xctestplan")) continue;

        const testPlanPath = path.join(folderPath, file);
        const content = fs.readFileSync(testPlanPath, "utf-8");
        const testPlanData = JSON.parse(content);

        testPlans.push({
          path: testPlanPath,
          type: this.getTestPlanType(folderPath),
          name: path.basename(file, ".xctestplan"),
          configurations: testPlanData.configurations || []
        });
      }
    }

    this._testPlans = testPlans;
    this.emit("testPlansChanged");
  }

  async runTests(testPlan: TestPlan, configuration?: string, withoutBuilding: boolean = false) {
    if (!this._context) return;
    
    const args = [
      "test-without-building",
      "-xctestrun", testPlan.path
    ];

    if (configuration) {
      args.push("-only-test-configuration", configuration);
    }

    // Add the command execution logic here using the context
    // this._context.buildManager.runXcodebuildCommand(args);
  }
} 