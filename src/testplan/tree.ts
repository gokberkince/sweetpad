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
    }
  }
}

class TestPlanItem extends vscode.TreeItem {
  constructor(
    public readonly testPlan: TestPlan,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    private readonly isSelected: boolean
  ) {
    super(testPlan.name, collapsibleState);
    this.contextValue = "testPlan";
    this.iconPath = new vscode.ThemeIcon(isSelected ? "check" : "file-text");
    this.description = isSelected ? "(selected)" : undefined;
    this.command = {
      command: "sweetpad.testplan.select",
      title: "Select Test Plan",
      arguments: [testPlan]
    };
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
      return [
        new TestPlanTypeItem("smoke", vscode.TreeItemCollapsibleState.Collapsed),
        new TestPlanTypeItem("regression", vscode.TreeItemCollapsibleState.Collapsed),
        new TestPlanTypeItem("snapshot", vscode.TreeItemCollapsibleState.Collapsed),
        new TestPlanTypeItem("unit", vscode.TreeItemCollapsibleState.Collapsed)
      ];
    }

    if (element instanceof TestPlanTypeItem) {
      const selectedTestPlan = this.manager.selectedTestPlan;
      return this.manager.testPlans
        .filter(plan => plan.type === element.type)
        .map(plan => new TestPlanItem(
          plan, 
          vscode.TreeItemCollapsibleState.None,
          selectedTestPlan?.path === plan.path
        ));
    }

    return [];
  }
} 