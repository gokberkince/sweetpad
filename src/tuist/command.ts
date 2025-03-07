import * as vscode from "vscode";
import { restartSwiftLSP } from "../build/utils";
import { getIsTuistInstalled, tuistClean, tuistEdit, tuistGenerate, tuistInstall } from "../common/cli/scripts";
import { ExtensionError } from "../common/errors";
import { CommandExecution } from "../common/commands";
import { exec } from "../common/exec.js";

async function tuistCheckInstalled() {
  const isInstalled = await getIsTuistInstalled();
  if (!isInstalled) {
    throw new ExtensionError("Tuist is not installed");
  }
}

export async function tuistGenerateCommand(context: CommandExecution) {
  await tuistCheckInstalled();

  const options = await vscode.window.showQuickPick([
    { label: "Generate with binary cache", value: false },
    { label: "Generate without binary cache", value: true }
  ], {
    placeHolder: "Select generation option"
  });

  if (!options) return;

  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Tuist: Generating Xcode project...",
    cancellable: false
  }, async (progress) => {
    try {
      const args = ["generate", "--no-open"];
      if (options.value) {
        args.push("--no-binary-cache");
      }
      
      await exec({
        command: "tuist",
        args: args
      });

      await restartSwiftLSP();
      vscode.window.showInformationMessage("Tuist: Project generated successfully");
    } catch (err: any) {
      if (err?.toString().includes("tuist install")) {
        vscode.window.showErrorMessage(`Please run "tuist install" first`);
      } else {
        vscode.window.showErrorMessage(`Tuist: Failed to generate project - ${err}`);
      }
      throw err;
    }
  });
}

export async function tuistInstallCommand(context: CommandExecution) {
  await tuistCheckInstalled();

  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Tuist: Installing dependencies...",
    cancellable: false
  }, async (progress) => {
    try {
      await exec({
        command: "tuist",
        args: ["install"]
      });
      
      await restartSwiftLSP();
      vscode.window.showInformationMessage("Tuist: Dependencies installed successfully");
    } catch (err: any) {
      vscode.window.showErrorMessage(`Tuist: Failed to install dependencies - ${err}`);
      throw err;
    }
  });
}

export async function tuistCleanCommand(context: CommandExecution) {
  await tuistCheckInstalled();

  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Tuist: Cleaning project...",
    cancellable: false
  }, async (progress) => {
    try {
      await exec({
        command: "tuist",
        args: ["clean"]
      });
      vscode.window.showInformationMessage("Tuist: Project cleaned successfully");
    } catch (err: any) {
      vscode.window.showErrorMessage(`Tuist: Failed to clean project - ${err}`);
      throw err;
    }
  });
}

export async function tuistEditComnmand(context: CommandExecution) {
  await tuistCheckInstalled();

  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Tuist: Opening manifest editor...",
    cancellable: false
  }, async (progress) => {
    try {
      await exec({
        command: "tuist",
        args: ["edit"]
      });
      vscode.window.showInformationMessage("Tuist: Manifest editor opened successfully");
    } catch (err: any) {
      vscode.window.showErrorMessage(`Tuist: Failed to open manifest editor - ${err}`);
      throw err;
    }
  });
}
