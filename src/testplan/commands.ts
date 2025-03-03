import * as vscode from "vscode";
import * as path from "path";
import { CommandExecution } from "../common/commands";
import { runTask } from "../common/tasks";
import { TestPlan } from "./manager";
import { askXcodeWorkspacePath, getWorkspacePath } from "../build/utils";
import { getXcodeBuildDestinationString } from "../build/commands";
import { askDestinationToRunOn, askSchemeForBuild, askConfiguration } from "../build/utils";
import { getBuildSettingsOptional } from "../common/cli/scripts";

async function getTestingParameters(context: CommandExecution) {
  const xcworkspace = await askXcodeWorkspacePath(context.context);
  const scheme = await askSchemeForBuild(context.context, { 
    title: "Select scheme to test", 
    xcworkspace: xcworkspace 
  });
  const configuration = await askConfiguration(context.context, { xcworkspace: xcworkspace });

  const buildSettings = await getBuildSettingsOptional({
    scheme: scheme,
    configuration: configuration,
    sdk: undefined,
    xcworkspace: xcworkspace,
  });

  const destination = await askDestinationToRunOn(context.context, buildSettings);
  const destinationRaw = getXcodeBuildDestinationString({ destination: destination });

  return {
    xcworkspace,
    scheme,
    configuration,
    destinationRaw
  };
}

function getTestPlanName(testPlanPath: string): string {
  const basename = path.basename(testPlanPath);
  return basename.replace('.xctestplan', '');
}

export async function runTestsCommand(context: CommandExecution, testPlan: TestPlan) {
  const { xcworkspace, scheme, configuration, destinationRaw } = await getTestingParameters(context);
  const configurations = testPlan.configurations;
  const testPlanName = getTestPlanName(testPlan.path);

  if (!configurations || configurations.length === 0) {
    await runTask(context.context, {
      name: "Run Tests",
      lock: "sweetpad.build",
      terminateLocked: true,
      callback: async (terminal) => {
        await terminal.execute({
          command: "xcodebuild",
          args: [
            "test",
            "-workspace", xcworkspace,
            "-scheme", scheme,
            "-configuration", configuration,
            "-destination", destinationRaw,
            "-testPlan", testPlanName
          ]
        });
      }
    });
    return;
  }

  const configItems = configurations.map(config => ({
    label: config.name,
    description: `Region: ${config.options.region || "Default"}, Language: ${config.options.language || "Default"}`,
    configuration: config
  }));

  const selectedConfig = await vscode.window.showQuickPick(configItems, {
    placeHolder: "Select a configuration to run tests with"
  });

  if (!selectedConfig) return;

  await runTask(context.context, {
    name: "Run Tests",
    lock: "sweetpad.build",
    terminateLocked: true,
    callback: async (terminal) => {
      await terminal.execute({
        command: "xcodebuild",
        args: [
          "test",
          "-workspace", xcworkspace,
          "-scheme", scheme,
          "-configuration", configuration,
          "-destination", destinationRaw,
          "-testPlan", testPlanName,
          "-only-test-configuration", selectedConfig.configuration.name
        ]
      });
    }
  });
}

export async function runTestsWithoutBuildingCommand(context: CommandExecution, testPlan: TestPlan) {
  const { xcworkspace, scheme, configuration, destinationRaw } = await getTestingParameters(context);
  const configurations = testPlan.configurations;
  const testPlanName = getTestPlanName(testPlan.path);

  if (!configurations || configurations.length === 0) {
    await runTask(context.context, {
      name: "Run Tests Without Building",
      lock: "sweetpad.build",
      terminateLocked: true,
      callback: async (terminal) => {
        await terminal.execute({
          command: "xcodebuild",
          args: [
            "test-without-building",
            "-workspace", xcworkspace,
            "-scheme", scheme,
            "-configuration", configuration,
            "-destination", destinationRaw,
            "-testPlan", testPlanName
          ]
        });
      }
    });
    return;
  }

  const configItems = configurations.map(config => ({
    label: config.name,
    description: `Region: ${config.options.region || "Default"}, Language: ${config.options.language || "Default"}`,
    configuration: config
  }));

  const selectedConfig = await vscode.window.showQuickPick(configItems, {
    placeHolder: "Select a configuration to run tests with"
  });

  if (!selectedConfig) return;

  await runTask(context.context, {
    name: "Run Tests Without Building",
    lock: "sweetpad.build",
    terminateLocked: true,
    callback: async (terminal) => {
      await terminal.execute({
        command: "xcodebuild",
        args: [
          "test-without-building",
          "-workspace", xcworkspace,
          "-scheme", scheme,
          "-configuration", configuration,
          "-destination", destinationRaw,
          "-testPlan", testPlanName,
          "-only-test-configuration", selectedConfig.configuration.name
        ]
      });
    }
  });
} 