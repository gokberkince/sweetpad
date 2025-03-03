import * as vscode from "vscode";
import { restartSwiftLSP } from "../build/utils";
import { getIsTuistInstalled, tuistClean, tuistEdit, tuistGenerate, tuistInstall } from "../common/cli/scripts";
import { ExtensionError } from "../common/errors";

async function tuistCheckInstalled() {
  const isTuistInstalled = await getIsTuistInstalled();
  if (!isTuistInstalled) {
    throw new ExtensionError("Tuist is not installed");
  }
}

export async function tuistGenerateCommand() {
  await tuistCheckInstalled();

  const options = await vscode.window.showQuickPick([
    { label: "Generate with binary cache", value: false },
    { label: "Generate without binary cache", value: true }
  ], {
    placeHolder: "Select generation option"
  });

  if (!options) return;

  const raw = await tuistGenerate(options.value);
  if (raw.includes("tuist install")) {
    vscode.window.showErrorMessage(`Please run "tuist install" first`);
    return;
  }

  await restartSwiftLSP();

  vscode.window.showInformationMessage("The Xcode project was successfully generated using Tuist.");
}

export async function tuistInstallCommand() {
  await tuistCheckInstalled();

  await tuistInstall();

  await restartSwiftLSP();

  vscode.window.showInformationMessage("The Swift Package was successfully installed using Tuist.");
}

export async function tuistCleanCommand() {
  await tuistCheckInstalled();

  await tuistClean();

  vscode.window.showInformationMessage("Tuist cleaned.");
}

export async function tuistEditComnmand() {
  await tuistCheckInstalled();

  await tuistEdit();
}
