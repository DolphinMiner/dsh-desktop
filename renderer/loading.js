const indicator = document.querySelector('#indicator')
const title = document.querySelector('#title')
const message = document.querySelector('#message')
const progress = document.querySelector('#progress')
const actions = document.querySelector('#actions')
const retry = document.querySelector('#retry')
const logs = document.querySelector('#logs')

function render(state) {
  const failed = state.phase === 'error'
  const recovering = failed && state.recovery !== undefined
  indicator.className = failed ? 'indicator is-error' : 'indicator is-starting'
  title.textContent = recovering ? 'Restarting Harness' : failed ? 'Harness could not start' : 'Starting Harness'
  message.textContent = state.message
  progress.hidden = failed && !recovering
  actions.hidden = !failed
}

retry.addEventListener('click', async () => {
  retry.disabled = true
  render({ phase: 'starting', message: 'Retrying the local Harness runtime...' })
  try {
    await window.dshDesktop.retryHarness()
  } finally {
    retry.disabled = false
  }
})

logs.addEventListener('click', () => window.dshDesktop.showHarnessLog())

window.dshDesktop.onHarnessState(render)
window.dshDesktop.getHarnessState().then(render)
