import * as vscode from "vscode";
import { TestPlan, TestPlanType, TestPlansManager } from "./manager";

class TestPlanTypeItem extends vscode.TreeItem {
  constructor(
    public readonly type: TestPlanType,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(TestPlanTypeItem.getLabel(type), collapsibleState);
    this.contextValue = "testPlanType";
    this.iconPath = new vscode.ThemeIcon("testing-group-by-file");
  }

  private static getLabel(type: TestPlanType): string {
    switch (type) {
      case "smoke":
        return "Smoke Tests";
      case "regression":
        return "Regression Tests";
      case "snapshot":
        return "Snapshot Tests";
      case "unit":
        return "Unit Tests";
      case "event":
        return "Event Tests";
    }
  }
}

class TestPlanItem extends vscode.TreeItem {
  constructor(
    public readonly testPlan: TestPlan,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    private readonly isSelected: boolean,
    private readonly parentType: TestPlanType
  ) {
    super(testPlan.name, collapsibleState);
    
    // Add test target to the testPlan if it's a test plan
    const testTarget = this.getTestTarget(testPlan.name, parentType);
    const planWithTarget = testTarget ? { ...testPlan, testTarget } : testPlan;

    // Set context value for command enablement
    this.contextValue = testTarget ? "testPlan-runnable" : "testPlan";
    
    // Set icon and description
    this.iconPath = new vscode.ThemeIcon(isSelected ? "check" : "file-text");
    this.description = isSelected ? "(selected)" : undefined;

    // Add select command
    this.command = {
      command: "sweetpad.testplan.select",
      title: "Select Test Plan",
      arguments: [undefined, planWithTarget]
    };
  }

  private getTestTarget(testPlanName: string, type: TestPlanType): string | undefined {
    // Extract the module name (e.g., "MSearch" from "MSearchRegressionTests")
    const match = testPlanName.match(/^(.+?)(Smoke|Regression|Snapshot|Unit|Event)Tests$/);
    if (!match) return undefined;

    const [, moduleName, testType] = match;
    if (!moduleName) return undefined;

    // Return the full test target name
    return `${moduleName}${testType}Tests`;
  }
}

export class TestPlansTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private manager: TestPlansManager) {
    this.manager.on("testPlansChanged", () => {
      this._onDidChangeTreeData.fire();
    });
    this.manager.on("selectedTestPlanChanged", () => {
      this._onDidChangeTreeData.fire();
    });
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      // Only show types that have test plans
      const types: TestPlanType[] = ["smoke", "regression", "snapshot", "unit", "event"];
      return types
        .filter(type => this.manager.testPlans.some(plan => plan.type === type))
        .map(type => new TestPlanTypeItem(type, vscode.TreeItemCollapsibleState.Expanded));
    }

    if (element instanceof TestPlanTypeItem) {
      const selectedTestPlan = this.manager.selectedTestPlan;
      return this.manager.testPlans
        .filter(plan => plan.type === element.type)
        .map(plan => new TestPlanItem(
          plan, 
          vscode.TreeItemCollapsibleState.None,
          selectedTestPlan?.path === plan.path,
          element.type
        ));
    }

    return [];
  }
} 