import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { InstallerError } from "./errors.mjs";

function normalizeAnswer(value) {
  return String(value ?? "").trim();
}

export function createTerminalPrompter({ input = defaultInput, output = defaultOutput } = {}) {
  const ask = async (question) => {
    const readline = createInterface({ input, output });
    try {
      return normalizeAnswer(await readline.question(question));
    } catch (cause) {
      throw new InstallerError("Interactive setup was cancelled.", { code: "PROMPT_ABORTED", cause });
    } finally {
      readline.close();
    }
  };

  return Object.freeze({
    input,
    output,
    async inputText({ message, defaultValue = "", validate = () => true }) {
      while (true) {
        const suffix = defaultValue ? ` [${defaultValue}]` : "";
        const answer = await ask(`${message}${suffix}: `);
        const value = answer || defaultValue;
        const validation = validate(value);
        if (validation === true) return value;
        output.write(`${typeof validation === "string" ? validation : "Enter a valid value."}\n`);
      }
    },
    async confirm({ message, defaultValue = false }) {
      const hint = defaultValue ? "Y/n" : "y/N";
      while (true) {
        const answer = (await ask(`${message} [${hint}]: `)).toLowerCase();
        if (!answer) return defaultValue;
        if (["y", "yes"].includes(answer)) return true;
        if (["n", "no"].includes(answer)) return false;
        output.write("Enter yes or no.\n");
      }
    },
    async select({ message, choices, defaultValue }) {
      output.write(`${message}\n`);
      choices.forEach((choice, index) => output.write(`  ${index + 1}. ${choice.label}\n`));
      const selected = await this.inputText({
        message: "Choose one",
        defaultValue: defaultValue ? String(choices.findIndex((choice) => choice.value === defaultValue) + 1) : "",
        validate(value) {
          const index = Number(value) - 1;
          return Number.isInteger(index) && choices[index] ? true : "Choose one listed number.";
        }
      });
      return choices[Number(selected) - 1].value;
    },
    async multiselect({ message, choices, defaultValues = [] }) {
      output.write(`${message}\n`);
      choices.forEach((choice, index) => output.write(`  ${index + 1}. ${choice.label}\n`));
      const defaultNumbers = defaultValues.map((value) => choices.findIndex((choice) => choice.value === value) + 1);
      if (defaultNumbers.some((number) => number < 1)) {
        throw new InstallerError("A multi-select default is not one of the available choices.", { code: "PROMPT_INVALID" });
      }
      const selected = await this.inputText({
        message: "Choose one or more comma-separated numbers",
        defaultValue: defaultNumbers.join(", "),
        validate(value) {
          const numbers = value.split(",").map((item) => Number(item.trim()));
          return numbers.length > 0 && numbers.every((number) => Number.isInteger(number) && choices[number - 1])
            ? true
            : "Choose at least one listed number.";
        }
      });
      return [...new Set(selected.split(",").map((item) => choices[Number(item.trim()) - 1].value))];
    }
  });
}
