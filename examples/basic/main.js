// A minimal browser built on STomp + STicks: tabs, an address bar, an
// extension toolbar with popups, and an extension manager.
import EpoxyTransport from '@mercuryworkshop/epoxy-transport'
import { StompController } from '@sysce/stomp'
import { Sticks } from 'sticks'

const $ = (selector) => document.querySelector(selector)
const wispUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/wisp/`
const transport = new EpoxyTransport({ wisp: wispUrl })

// ---- tabs ------------------------------------------------------------------

/** @type {Map<number, { id: number, url: string, title: string, loading: boolean, iframe: HTMLIFrameElement, frame: any }>} */
const tabs = new Map()
let nextId = 1
let activeId = null
let popupAnchor = null

const tabInfo = (tab, index) => ({
  id: tab.id,
  windowId: 1,
  index,
  url: tab.url,
  title: tab.title || tab.url,
  active: tab.id === activeId,
  status: tab.loading ? 'loading' : 'complete',
})

// What STicks needs to know about this browser. Only the first four are required.
const host = {
  getTabId(frameWindow) {
    for (const tab of tabs.values()) if (tab.iframe.contentWindow === frameWindow) return tab.id
    return null
  },
  getTab(id) {
    const list = [...tabs.values()]
    const index = list.findIndex((tab) => tab.id === id)
    return index < 0 ? null : tabInfo(list[index], index)
  },
  getTabs: () => [...tabs.values()].map(tabInfo),
  getActiveTabId: () => activeId,
  getTabWindow: (id) => tabs.get(id)?.iframe.contentWindow ?? null,
  createTab: (url, { active }) => openTab(url, active),
  navigateTab: (id, url) => navigate(tabs.get(id), url),
  closeTab: (id) => closeTab(id),
  reloadTab: (id) => tabs.get(id)?.frame?.reload(),
  activateTab: (id) => activate(id),
  goBack: (id) => tabs.get(id)?.frame?.back(),
  goForward: (id) => tabs.get(id)?.frame?.forward(),
  openPopup(extId, tabId) {
    showPopup(extId, tabId)
    return true
  },
  closePopup: () => hidePopup(),
  showNotification: (_extId, _id, options) => toast([options.title, options.message].filter(Boolean).join(': ')),
}

const sticks = new Sticks({ host, transport })

const controller = new StompController({
  serviceworker: await StompController.register('/stomp/'),
  transport,
  directory: '/stomp/',
  codec: 'xor',
  hooks: Sticks.hooks(),
  onRequest: sticks.onRequest,
  onNavigate(info, frame) {
    const tab = [...tabs.values()].find((candidate) => candidate.frame === frame)
    if (!tab) return
    Object.assign(tab, { url: info.url, title: info.title, loading: false })
    sticks.navigated(tab.id, info)
    render()
  },
  onOpen: (url) => openTab(url, true),
})
await controller.wait()
sticks.attach(controller)
await sticks.ready()

function openTab(url = 'https://example.com/', active = true) {
  const id = nextId++
  const iframe = document.createElement('iframe')
  iframe.className = 'page'
  $('#pages').append(iframe)
  const tab = { id, url, title: '', loading: true, iframe, frame: null }
  tabs.set(id, tab)
  sticks.tabCreated(id)
  navigate(tab, url)
  if (active || activeId === null) activate(id)
  render()
  return id
}

function navigate(tab, url) {
  if (!tab) return
  tab.url = url
  if (sticks.isExtensionUrl(url)) {
    // extension pages (options, tabs an extension opens) load in a plain iframe, not through STomp
    tab.frame = null
    tab.loading = false
    sticks.mountPage(tab.iframe, url, tab.id)
  } else {
    tab.loading = true
    tab.frame ??= controller.createFrame(tab.iframe)
    tab.frame.go(url).catch(console.error)
  }
  sticks.tabUpdated(tab.id, { url, status: tab.loading ? 'loading' : 'complete' })
  render()
}

function activate(id) {
  activeId = id
  for (const tab of tabs.values()) tab.iframe.hidden = tab.id !== id
  sticks.tabActivated(id)
  render()
}

function closeTab(id) {
  const tab = tabs.get(id)
  if (!tab) return
  tab.iframe.remove()
  tabs.delete(id)
  sticks.tabRemoved(id)
  if (activeId === id) {
    const next = [...tabs.keys()].pop()
    if (next === undefined) openTab()
    else activate(next)
  }
  render()
}

// ---- address bar -------------------------------------------------------------

function toUrl(text) {
  const value = text.trim()
  if (/^chrome-extension:\/\//.test(value)) return sticks.resolveUrl(value)
  if (/^https?:\/\//i.test(value)) return value
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(value)) return `https://${value}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`
}

$('#address-form').addEventListener('submit', (event) => {
  event.preventDefault()
  navigate(tabs.get(activeId), toUrl($('#address').value))
  $('#address').blur()
})
$('#back').onclick = () => tabs.get(activeId)?.frame?.back()
$('#forward').onclick = () => tabs.get(activeId)?.frame?.forward()
$('#reload').onclick = () => tabs.get(activeId)?.frame?.reload()
$('#new-tab').onclick = () => openTab()

// ---- popups --------------------------------------------------------------------

function fitPopup(iframe) {
  const doc = iframe.contentDocument
  if (!doc?.documentElement) return
  // Chrome sizes a popup to its content, 25-800 px wide and 25-600 px tall
  const size = () => {
    const root = doc.documentElement
    iframe.style.width = '800px'
    iframe.style.height = '25px'
    const previous = root.style.width
    root.style.width = 'max-content'
    const width = Math.min(800, Math.max(25, Math.ceil(root.getBoundingClientRect().width)))
    root.style.width = previous
    iframe.style.width = `${width}px`
    iframe.style.height = `${Math.min(600, Math.max(25, root.scrollHeight))}px`
  }
  size()
  let pending = 0
  new doc.defaultView.ResizeObserver(() => {
    cancelAnimationFrame(pending)
    pending = requestAnimationFrame(size)
  }).observe(doc.body ?? doc.documentElement)
}

function showPopup(extId, tabId) {
  hidePopup()
  const box = $('#popup')
  const iframe = document.createElement('iframe')
  iframe.addEventListener('load', () => fitPopup(iframe))
  box.append(iframe)
  const anchor = popupAnchor ?? $('#extensions').getBoundingClientRect()
  box.style.top = `${anchor.bottom + 6}px`
  box.style.right = `${Math.max(8, innerWidth - anchor.right)}px`
  box.hidden = false
  sticks.mountPopup(iframe, extId, tabId)
}

function hidePopup() {
  const box = $('#popup')
  const iframe = box.querySelector('iframe')
  if (iframe) sticks.unmountPopup(iframe)
  box.replaceChildren()
  box.hidden = true
}

document.addEventListener('mousedown', (event) => {
  if (!$('#popup').contains(event.target) && !event.target.closest?.('.ext')) hidePopup()
})
document.addEventListener('keydown', (event) => event.key === 'Escape' && hidePopup())

// ---- extension manager -------------------------------------------------------

async function install(label, job) {
  const status = $('#install-status')
  status.textContent = `Installing ${label}…`
  try {
    const id = await job()
    status.textContent = `Installed ${sticks.list(null).find((ext) => ext.id === id)?.name ?? id}`
  } catch (error) {
    status.textContent = `Couldn't install ${label}: ${error.message}`
  }
}

$('#open-manager').onclick = () => $('#manager').showModal()
$('#install-store').addEventListener('submit', (event) => {
  event.preventDefault()
  const id = /[a-p]{32}/.exec(event.target.source.value.toLowerCase())?.[0]
  if (!id) {
    $('#install-status').textContent = 'Paste a Chrome Web Store link or a 32-letter extension ID'
    return
  }
  event.target.reset()
  install(id, () => sticks.installFromWebStore(id))
})
$('#install-file').addEventListener('change', async (event) => {
  const file = event.target.files[0]
  event.target.value = ''
  if (file) install(file.name, async () => sticks.install(await file.arrayBuffer(), file.name))
})

// ---- rendering -----------------------------------------------------------------

function render() {
  const active = tabs.get(activeId)
  if (active && document.activeElement !== $('#address')) $('#address').value = sticks.displayUrl(active.url)

  $('#tab-list').replaceChildren(
    ...[...tabs.values()].map((tab) => {
      const item = document.createElement('li')
      item.className = tab.id === activeId ? 'tab active' : 'tab'
      const select = document.createElement('button')
      select.type = 'button'
      select.textContent = tab.title || sticks.displayUrl(tab.url)
      select.onclick = () => activate(tab.id)
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'close'
      close.textContent = '×'
      close.title = 'Close tab'
      close.onclick = () => closeTab(tab.id)
      item.append(select, close)
      return item
    }),
  )

  $('#extensions').replaceChildren(
    ...sticks
      .list(activeId)
      .filter((ext) => ext.enabled)
      .map((ext) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'ext'
        button.title = ext.title
        button.disabled = !ext.actionEnabled
        const icon = document.createElement('img')
        icon.src = ext.iconUrl ?? ''
        icon.alt = ''
        button.append(icon)
        if (ext.badgeText) {
          const badge = document.createElement('span')
          badge.className = 'badge'
          badge.textContent = ext.badgeText
          badge.style.background = ext.badgeColor
          if (ext.badgeTextColor) badge.style.color = ext.badgeTextColor
          button.append(badge)
        }
        button.onclick = () => {
          popupAnchor = button.getBoundingClientRect()
          sticks.clickAction(ext.id, activeId)
        }
        return button
      }),
  )

  $('#installed').replaceChildren(
    ...sticks.list(null).map((ext) => {
      const item = document.createElement('li')
      const name = document.createElement('span')
      name.textContent = `${ext.name} ${ext.version}`
      const toggle = document.createElement('input')
      toggle.type = 'checkbox'
      toggle.checked = ext.enabled
      toggle.title = 'Enabled'
      toggle.onchange = () => sticks.setEnabled(ext.id, toggle.checked)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = 'Remove'
      remove.onclick = () => sticks.uninstall(ext.id)
      item.append(toggle, name, remove)
      if (ext.optionsUrl) {
        const options = document.createElement('button')
        options.type = 'button'
        options.textContent = 'Options'
        options.onclick = () => {
          $('#manager').close()
          openTab(ext.optionsUrl, true)
        }
        item.append(options)
      }
      return item
    }),
  )

  const { compiled, total, skipped, truncated } = sticks.ruleStats
  $('#rule-stats').textContent = total ? `declarativeNetRequest: ${compiled} of ${total} rules applied (${skipped} unsupported, ${truncated} over the cap)` : ''
}

let toastTimer = 0
function toast(text) {
  const element = $('#toast')
  element.textContent = text
  element.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (element.hidden = true), 4000)
}

sticks.onChange(render)
openTab()
