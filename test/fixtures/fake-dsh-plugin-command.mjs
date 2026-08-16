const expected = ['plugin', '--profile', 'desktop', 'add', 'fixture-plugin']

if (process.env.DSH_PLUGIN_FIXTURE_MODE === 'hang') {
  setInterval(() => undefined, 1_000)
} else if (process.env.DSH_HOME === process.env.DSH_PLUGIN_EXPECTED_HOME &&
  JSON.stringify(process.argv.slice(2)) === JSON.stringify(expected)) {
  process.stderr.write('fixture ok\n')
} else {
  process.stderr.write(`unexpected invocation: ${JSON.stringify(process.argv.slice(2))}\n`)
  process.exitCode = 2
}
