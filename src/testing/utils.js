import * as vscode from "vscode";
import { ExtensionContext } from "../extension";
import { TestPlan, TestPlanConfiguration } from "../testplan/manager";

/**
 * Ask user to select a test plan
 */
export async function askTestPlan(
  context: ExtensionContext,
  options: {
    title?: string;
    testPlans: TestPlan[];
  }
): Promise<TestPlan | undefined> {
  const items = options.testPlans.map((plan) => {
    return {
      label: plan.name,
      description: `(${plan.type})`,
      plan: plan,
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    title: options.title ?? "Select a test plan",
    placeHolder: "Select a test plan",
  });

  return selected?.plan;
}

/**
 * Ask user to select a test plan configuration
 */
export async function askTestPlanConfiguration(
  context: ExtensionContext,
  options: {
    title?: string;
    configurations: TestPlanConfiguration[];
  }
): Promise<TestPlanConfiguration | undefined> {
  const items = options.configurations.map((config) => {
    const regionLabel = config.options.region ? ` (${config.options.region})` : '';
    return {
      label: config.name,
      description: regionLabel,
      config: config,
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    title: options.title ?? "Select a configuration",
    placeHolder: "Select a configuration",
  });

  return selected?.config;
} 