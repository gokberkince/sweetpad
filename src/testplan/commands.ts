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

async function selectTestConfiguration(configurations: TestPlan['configurations']): Promise<{ configuration?: { name: string }, isAllRegions: boolean }> {
  // Add "All Regions" option at the top
  const configItems = [
    {
      label: "All Regions",
      description: "Run tests for all regions",
      configuration: undefined
    },
    ...configurations.map(config => ({
      label: config.name,
      description: `Region: ${config.options.region || "Default"}, Language: ${config.options.language || "Default"}`,
      configuration: config
    }))
  ];

  const selectedConfig = await vscode.window.showQuickPick(configItems, {
    placeHolder: "Select a configuration or All Regions"
  });

  if (!selectedConfig) {
    return { isAllRegions: false };
  }

  return {
    configuration: selectedConfig.configuration,
    isAllRegions: !selectedConfig.configuration
  };
}

export async function runTestsCommand(context: CommandExecution, testPlan: TestPlan) {
  // Get testing parameters
  const { xcworkspace, scheme, configuration, destinationRaw } = await getTestingParameters(context);
  
  // Ask for region configuration if available
  let testConfiguration: string | undefined;
  if (testPlan.configurations && testPlan.configurations.length > 0) {
    // Add "All Regions" option
    const allRegionsOption = {
      label: "All Regions",
      description: "Run tests for all regions",
      config: undefined
    };
    
    const configItems = [
      allRegionsOption,
      ...testPlan.configurations.map(config => ({
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
    }
  }
  
  // Build command arguments
  const args = [
    "test",
    "-workspace", xcworkspace,
    "-scheme", scheme,
    "-configuration", configuration,
    "-destination", destinationRaw,
    "-testPlan", testPlan.name
  ];
  
  // Add test configuration if selected
  if (testConfiguration) {
    args.push("-only-test-configuration", testConfiguration);
  }
  
  // Run the task
  await runTask(context.context, {
    name: `Run Tests: ${testPlan.name}`,
    lock: "sweetpad.build",
    terminateLocked: true,
    callback: async (terminal) => {
      await terminal.execute({
        command: "xcodebuild",
        args
      });
    }
  });
}

export async function runTestsWithoutBuildingCommand(context: CommandExecution, testPlan: TestPlan) {
  // Get testing parameters
  const { xcworkspace, scheme, configuration, destinationRaw } = await getTestingParameters(context);
  
  // Ask for region configuration if available
  let testConfiguration: string | undefined;
  if (testPlan.configurations && testPlan.configurations.length > 0) {
    // Add "All Regions" option
    const allRegionsOption = {
      label: "All Regions",
      description: "Run tests for all regions",
      config: undefined
    };
    
    const configItems = [
      allRegionsOption,
      ...testPlan.configurations.map(config => ({
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
    }
  }
  
  // Build command arguments
  const args = [
    "test-without-building",
    "-workspace", xcworkspace,
    "-scheme", scheme,
    "-configuration", configuration,
    "-destination", destinationRaw,
    "-testPlan", testPlan.name
  ];
  
  // Add test configuration if selected
  if (testConfiguration) {
    args.push("-only-test-configuration", testConfiguration);
  }
  
  // Run the task
  await runTask(context.context, {
    name: `Run Tests Without Building: ${testPlan.name}`,
    lock: "sweetpad.build",
    terminateLocked: true,
    callback: async (terminal) => {
      await terminal.execute({
        command: "xcodebuild",
        args
      });
    }
  });
} 