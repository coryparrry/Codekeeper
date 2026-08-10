function posixQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function formatCommand(executable, args = [], platform = process.platform) {
  const quote = platform === "win32" ? powershellQuote : posixQuote;
  const command = [executable, ...args].map(quote).join(" ");
  return platform === "win32" ? `& ${command}` : command;
}
