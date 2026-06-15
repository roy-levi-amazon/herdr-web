export function shellCommand(argv: readonly string[]) {
  return argv.map(shellQuote).join(" ");
}

export function shellQuote(value: string) {
  return /^[A-Za-z0-9_/:=.,@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
