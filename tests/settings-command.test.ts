import { describe, expect, test } from "bun:test";
import {
  applySettingChange,
  findSettingSpec,
  listSettingsMessage,
  parseSettingsCommand,
  showSettingMessage,
  SETTING_SPECS,
} from "../src/settings-command";
import { settingsCompletions } from "../src/settings-autocomplete";
import { normalizeSettings, type PumSettings } from "../src/settings";

const settings: PumSettings = normalizeSettings({});

function set(input: string): { settings: PumSettings; message: string } {
  const command = parseSettingsCommand(input);
  if (command?.action !== "set") throw new Error(`not a set command: ${input}`);
  return applySettingChange(settings, command.spec, command.value);
}

describe("/theme alias", () => {
  test("uses the same validation and scope as /settings theme", () => {
    for (const suffix of ["", " NORD", " gruvbox --global", " --global nord"]) {
      expect(parseSettingsCommand(`/theme${suffix}`)).toEqual(parseSettingsCommand(`/settings theme${suffix}`));
    }
    expect(set("/theme NORD").settings.theme).toBe("nord");
    expect(() => set("/theme invalid")).toThrow(/unknown value/);
    expect(parseSettingsCommand("/themes nord")).toBeUndefined();
  });

  test("completes alias values with original offsets and theme preview metadata", () => {
    const input = "  /theme GRU";
    expect(settingsCompletions(input, input.length, process.cwd())).toEqual([
      { start: 9, end: 12, replacement: "gruvbox", previewTheme: "gruvbox" },
    ]);
    expect(settingsCompletions("/theme", 6, process.cwd())).toEqual([]);
    expect(settingsCompletions("/theme nord", 11, process.cwd())).toEqual([]);
    const flag = "/theme nord --";
    expect(settingsCompletions(flag, flag.length, process.cwd())).toEqual([
      { start: 12, end: 14, replacement: "--global", description: "write pum.json" },
    ]);
    expect(settingsCompletions("/settings outputMode q", 22, process.cwd())[0]?.previewTheme).toBeUndefined();
  });
});

describe("/settings command", () => {
  test("resolves a name by key, label, case, and separator", () => {
    for (const name of ["checkMode", "checkmode", "CHECKMODE", "check-mode", "check mode"]) {
      expect(findSettingSpec(name)?.key).toBe("checkMode");
    }
    expect(findSettingSpec("transcript detail")?.key).toBe("outputMode");
    expect(findSettingSpec("bashOutput.maxBytes")?.key).toBe("bashOutput.maxBytes");
  });

  test("reports near matches for an unknown name", () => {
    expect(() => parseSettingsCommand("/settings chekmode on")).toThrow(/did you mean: checkMode/);
  });

  test("sets a boolean, an enum, an int, and a nested bashOutput key", () => {
    expect(set("/settings showThinking ON").settings.showThinking).toBe(true);
    expect(set("/settings theme NORD").settings.theme).toBe("nord");
    expect(set("/settings maxActiveSubagents 3").settings.maxActiveSubagents).toBe(3);
    expect(set("/settings bashOutput.maxBytes 8192").settings.bashOutput?.maxBytes).toBe(8192);
    expect(set("/settings checkMode on").message).toBe("checkMode: off › on");
  });

  test("rejects a value outside the accepted set or range", () => {
    expect(() => set("/settings theme nope")).toThrow(/unknown value "nope"/);
    expect(() => set("/settings maxActiveSubagents 99")).toThrow(/accepts 1-25/);
    expect(() => set("/settings showThinking maybe")).toThrow(/accepts on or off/);
  });

  test("reads --global anywhere and keeps a quoted label as one name", () => {
    const command = parseSettingsCommand("/settings \"check mode\" on --global");
    expect(command).toMatchObject({ action: "set", value: "on", global: true });
    expect(command?.action === "set" && command.spec.key).toBe("checkMode");
  });

  test("routes checkPaths to a /check-path command", () => {
    expect(parseSettingsCommand("/settings checkPaths")).toMatchObject({
      action: "checkPaths",
      command: { action: "list" },
    });
    expect(parseSettingsCommand("/settings checkPaths add ../shared files")).toMatchObject({
      command: { action: "add", path: "../shared files" },
    });
    expect(() => parseSettingsCommand("/settings checkPaths edit x")).toThrow(/accepts list, add/);
  });

  test("shows and lists values with their scope", () => {
    const spec = findSettingSpec("outputMode")!;
    expect(showSettingMessage(spec, settings, {})).toBe(
      "outputMode: normal (global)\naccepted: quiet, normal, verbose",
    );
    expect(showSettingMessage(spec, settings, { outputMode: "quiet" })).toContain("(session)");
    const list = listSettingsMessage(settings, {}, 0);
    for (const candidate of SETTING_SPECS) expect(list).toContain(candidate.key);
  });

  test("ignores input that is not the command", () => {
    expect(parseSettingsCommand("/settingsfoo")).toBeUndefined();
    expect(parseSettingsCommand("tell me about /settings")).toBeUndefined();
  });
});

describe("/settings completion", () => {
  const complete = (input: string) => settingsCompletions(input, input.length, process.cwd())
    .map((completion) => completion.replacement);

  test("completes setting names, values, and the global flag", () => {
    expect(complete("/settings check")).toEqual(["checkMode", "checkModel", "checkPaths"]);
    expect(complete("/settings transcript")).toEqual(["outputMode"]);
    expect(complete("/settings outputMode ")).toEqual(["quiet", "normal", "verbose"]);
    expect(complete("/settings outputMode q")).toEqual(["quiet"]);
    expect(complete("/settings showThinking ")).toEqual(["on", "off"]);
    expect(complete("/settings checkPaths ")).toEqual(["list", "add", "remove", "clear"]);
    expect(complete("/settings outputMode quiet --")).toEqual(["--global"]);
  });

  test("replaces exactly the token under the cursor", () => {
    const [completion] = settingsCompletions("/settings outputMode qu", 22, process.cwd());
    expect(completion).toMatchObject({ start: 21, end: 22, replacement: "quiet" });
  });

  test("stops once the token under the cursor is whole", () => {
    // Enter runs the command instead of re-inserting the value it already reads.
    expect(complete("/settings theme tokyonight")).toEqual([]);
    expect(complete("/settings theme TOKYONIGHT")).toEqual([]);
    expect(complete("/settings showThinking on")).toEqual([]);
    expect(complete("/settings checkPaths list")).toEqual([]);
    expect(complete("/settings outputMode quiet --global")).toEqual([]);
    // A whole name that another name extends still stops, so Enter cannot turn
    // `checkMode` into `checkModel`.
    expect(complete("/settings checkMode")).toEqual([]);
    expect(complete("/settings bashOutput.strategy head")).toEqual([]);
    // A part of a value still completes.
    expect(complete("/settings theme tokyo")).toEqual(["tokyonight"]);
    expect(complete("/settings bashOutput.strategy hea")).toEqual(["headTail", "head"]);
    expect(complete("/settings checkMode ")).toEqual(["off", "on"]);
  });

  test("offers nothing for the command name or a free-text value", () => {
    expect(complete("/settings")).toEqual([]);
    expect(complete("/check-path add")).toEqual([]);
    expect(complete("/settings maxActiveSubagents ")).toEqual([]);
  });
});
