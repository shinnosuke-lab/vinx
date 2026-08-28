/**
 * Terminal-SPA-local labels (window chrome, status text, assistant chips).
 *
 * Kept separate from the shared component-library i18n (`@agentchat/lib/i18n`)
 * so the reused chat renderers still resolve their own keys while the terminal
 * chrome gets these.
 */

const I18N: Record<string, Record<string, string>> = {
  en: {
    appTitle: 'Terminal',
    newTerminal: 'New Terminal',
    toggleSplitDir: 'Toggle split direction',
    splitVertical: 'Horizontal',
    splitHorizontal: 'Vertical',

    connecting: 'Connecting...',
    connected: 'Connected',
    disconnected: 'Disconnected',
    connectFailed: 'Connection failed: {0}',
    sessionEnded: 'Session ended',
    closeTerminal: 'Close terminal',
    screenshot: 'Screenshot',
    reconnect: 'Reconnect',
    copy: 'Copy',
    copied: 'Copied',
    insertAI: 'Insert to Agent',
    insertAISend: 'Send to Agent',

    agentFab: 'Open Terminal Agent',
    agentTitle: 'Terminal Agent',
    newSession: 'New session',
    fullscreen: 'Fullscreen',
    restoreDefault: 'Restore default',
    minimize: 'Minimize',
    chipDiskUsage: 'Check disk usage',
    chipNetworkStatus: 'Check network status',
    chipSystemLogs: 'View system logs',
    inputPlaceholder: 'Ask the Agent...',
    stop: 'Stop',
    send: 'Send',
    thinking: 'Thinking...',
    requestFailed: 'Request failed: {0}',
    errorPrefix: 'Error: {0}',
    confirmed: 'Confirmed',
    cancelled: 'Cancelled',
    skillLoaded: 'Skill "{0}" activated',
    alreadyInTerminal: 'Terminal is ready — you are already in it.',
  },
  zh: {
    appTitle: '终端',
    newTerminal: '新终端',
    toggleSplitDir: '切换分屏方向',
    splitVertical: '横分',
    splitHorizontal: '竖分',

    connecting: '连接中...',
    connected: '已连接',
    disconnected: '已断开',
    connectFailed: '连接失败: {0}',
    sessionEnded: '会话已结束',
    closeTerminal: '关闭终端',
    screenshot: '截图',
    reconnect: '重新连接',
    copy: '复制',
    copied: '已复制',
    insertAI: '插入 Agent',
    insertAISend: '发送给 Agent',

    agentFab: '打开 Terminal Agent',
    agentTitle: 'Terminal Agent',
    newSession: '新建会话',
    fullscreen: '全屏',
    restoreDefault: '恢复默认',
    minimize: '最小化',
    chipDiskUsage: '查看磁盘使用',
    chipNetworkStatus: '检查网络状态',
    chipSystemLogs: '查看系统日志',
    inputPlaceholder: '询问 Agent...',
    stop: '停止',
    send: '发送',
    thinking: '思考中...',
    requestFailed: '请求失败: {0}',
    errorPrefix: '错误: {0}',
    confirmed: '已确认执行',
    cancelled: '已取消',
    skillLoaded: '已加载技能"{0}"',
    alreadyInTerminal: '终端已就绪 — 你正在终端中。',
  },
}

let currentLang: string = (navigator.language || 'en').startsWith('zh') ? 'zh' : 'en'

/**
 * Force the locale from the agent's `meta.lang` config hint ('zh' / 'en');
 * anything else (e.g. 'auto') keeps the browser auto-detection. Mirrors the
 * shared library's `setLanguage`, so the terminal chrome and the reused chat
 * components stay in the same language.
 */
export function setTerminalLanguage(lang?: string): void {
  const l = (lang || '').toLowerCase()
  if (l.startsWith('zh')) currentLang = 'zh'
  else if (l.startsWith('en')) currentLang = 'en'
}

export function t(key: string): string {
  return (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key
}

export function tf(key: string, ...args: (string | number)[]): string {
  let s = t(key)
  for (let i = 0; i < args.length; i++) {
    s = s.replace(new RegExp('\\{' + i + '\\}', 'g'), String(args[i]))
  }
  return s
}
