/**
 * App-side labels (the network panel, for now), English and Chinese.
 *
 * Same shape as the vendored trees' i18n modules (which stay untouched and
 * resolve their own keys): a flat table per language, picked once at load
 * from `navigator.language`. Exception text is *not* here on purpose — it is
 * shared verbatim with the guest CLI (`bridge: ...` on stderr), which speaks
 * English like the rest of the shell.
 *
 * Values may carry `backticks`; net-panel's <T> renders those runs as
 * <code>. tf() fills {0}-style slots.
 */

const I18N: Record<string, Record<string, string>> = {
	en: {
		npTitle: 'Network',
		npDefaultTag: 'default',
		npHostH: 'Host LAN',
		npHostD:
			'Your terminals reach each other; no internet. Split the terminal (or open a second tab) to network two machines.',
		npBridgeH: 'Bridge LAN',
		npBridgeD:
			"The same LAN, joined to friends' over WebRTC: host a room, share its code, `bridge say` to chat.",
		npWsproxyH: 'Relay LAN (wsproxy)',
		npWsproxyD:
			'Everyone on the same relay shares one segment — machines see each other — ' +
			'and the relay routes you out to the internet. v86’s public relay works as ' +
			'is; note that strangers share it, and `bridge`/chat don’t run here.',
		npWispH: 'Internet (wisp)',
		npWispD:
			'Pure outbound internet — TCP, TLS, WebSocket — through a wisp proxy you ' +
			'run yourself. Nobody on the relay sees anybody else.',
		npHowRun: 'How do I run one?',
		npWsUrlErr: 'Enter a ws:// or wss:// URL.',
		npWispUrlErr: 'Enter a wisp:// or wisps:// URL.',
		npProbe: 'Test',
		npProbeTesting: 'Testing the WebSocket handshake…',
		npProbeOk: '✓ Relay is reachable.',
		npProbeFailed: '✗ Cannot connect — check the address and whether the relay is running.',
		npProbeTimeout:
			'✗ Connection timed out — the relay or network is not responding. For a LAN ' +
			'address, also check the browser’s “local network access” permission ' +
			'(chrome://settings/content/localNetworkAccess) and any proxy in between.',
		npProbeMixed: '✗ An HTTPS page requires wss:// or wisps://.',
		npProbePolicy:
			'✗ This frame was not granted “local network access” — the browser parks ' +
			'such connections silently. Reload the page; if it persists, the embedding ' +
			'page must delegate the local-network-access permission.',
		npProbeDenied:
			'✗ The browser has local network access blocked for this site — allow it ' +
			'under chrome://settings/content/localNetworkAccess and retry.',
		npProbeInsecure:
			'✗ This page is plain http (not localhost), so the browser will never grant ' +
			'it local network access — no prompt, just a silent block. Open the page ' +
			'over https (dev: `npm run dev:https`) or via localhost, then retry.',
		npCancel: 'Cancel',
		npSave: 'Save',
		npSaveReload: 'Save & reload',
		npSaved: 'Saved',

		npBridgeTitle: 'Bridge to friends',
		npBridgeIntro:
			'One LAN across browsers: host a room, friends type its code, and every machine ' +
			'shares a segment — `ping`, `nc`, `httpd` across the internet, `bridge say` to ' +
			'chat. Or from a terminal: `bridge start`.',
		npManageBridge: 'Manage bridge…',
		npClose: 'Close',
		npBridgeOffHub:
			'This machine\u2019s NIC is wired to a relay right now, so a bridge cannot reach it. ' +
			'Switch the network to Host or Bridge LAN first (Save & reload), then come back here.',
		npStillUp: 'a bridge is still up — this machine leaves its segment under this mode',
		npHostRoom: 'Host a room',
		npHaveCode: 'I have a code',
		npRoomCodePh: 'room code',
		npBack: 'Back',
		npJoin: 'Join',
		npConnecting: 'connecting to room {0}…',
		npBridgedOne: 'bridged — the LANs are one segment',
		npCodeTitle: 'the room code — read it to your friends',
		npCopyTitle: 'copy the room code',
		npCopy: 'Copy',
		npDisconnect: 'Disconnect',
		npHostTag: 'host',
		npWaitFriends: 'waiting for friends — they type:',
		npClosed: 'the bridge closed',
		npReset: 'Reset',

		npCreateInvite: 'Create an invite',
		npHaveInvite: 'I have an invite',
		npPasteInvite: 'Paste their invite code…',
		npMakeAnswer: 'Make my answer code',
		npSendInvite: 'Send them this invite code, then paste their answer below.',
		npSendAnswer: 'Send them this answer code back; the bridge connects when they paste it.',
		npPasteAnswer: 'Paste their answer code…',
		npConnect: 'Connect',
		npWaitOther: 'waiting for the other side…',

		npSigRoomH: 'Room code',
		npSigRoomD:
			'Six letters, read aloud. The code travels sealed through public Nostr relays; ' +
			'STUN finds each side’s address. Neither ever carries your traffic.',
		npSigManualH: 'Manual bridge',
		npSigManualD:
			'No relays at all: you carry the pairing codes yourself — chat, email, ' +
			'a note. One friend at a time.',
		npAdvSummary: 'Advanced: relays & ICE',
		npAdvD:
			'Room codes travel via public Nostr relays — sealed, they only carry the ' +
			'handshake, never your traffic. Replace the list to use your own.',
		npAdvIceD:
			'ICE servers for the WebRTC handshake: `stun:` entries discover addresses, a ' +
			'`turn:` you provide relays traffic when nothing else connects — write it as ' +
			'`turn:host:3478|user|pass`. Empty restores the defaults.',

		npDgVmTab: 'VM · tab',
		npDgHub: 'one hub, this origin',
		npDgNoNet: 'no internet',
		npDgWisp: 'wisp relay',
		npDgWsproxy: 'wsproxy relay',
		npDgOthers: 'others',
		npDgWsNote: 'ethernet frames — everyone on the relay, one shared segment',
		npDgWispNote: 'TCP/UDP payloads only — peers never see each other',
		npDgNet: 'internet',
		npDgYourHub: 'your hub',
		npDgTheirHub: 'their hub',
		npDgP2P: 'WebRTC — peer to peer, one segment',
		npDgCodeRelay: 'code relay',
		npDgRoomNote: 'code via relay, addresses via STUN — traffic through neither',
		npDgCarry: 'the codes travel by you — chat, email',
		npDgManualNote: 'no relays; across the internet STUN still finds addresses',

		npFabTitle: 'Network: {0} — click to change',
		npChipTitle: 'Network settings',
		npDisconnected: 'offline',
		npRelayDownTitle: 'Relay disconnected — open network settings to check the address',

		npPromptMsg:
			'No internet in the VM yet — one click goes online through v86’s public relay (wsproxy).',
		npPromptGo: 'Go online',
		npPromptStay: 'Stay LAN-only',

		bootDownload: 'Fetching the machine image…',
		bootKernel: 'Starting Linux…',
		bootRestore: 'Waking the saved machine…',
		bootSlow: 'Boot is slower than usual — showing the console output…',
		bootPlayHint: 'space to play while you wait',
		bootFailedTitle: 'The Linux VM did not start',
		bootCopyDiag: 'Copy diagnostics',
		bootCopied: 'Copied — paste it into a bug report',
		bootRetry: 'Retry',
	},
	zh: {
		npTitle: '网络',
		npDefaultTag: '默认',
		npHostH: '本机局域网',
		npHostD: '你的各个终端彼此可达;不通互联网。分屏(或再开一个标签页)即可让两台机器组网。',
		npBridgeH: '桥接局域网',
		npBridgeD: '同样的局域网,再经 WebRTC 与朋友的相连:开房间、分享房间码,`bridge say` 发弹幕。',
		npWsproxyH: '中继局域网(wsproxy)',
		npWsproxyD:
			'同一中继上的所有人同一网段 — 机器彼此可见 — 并经中继访问互联网。' +
			'v86 官方公共中继开箱即用;注意网段与陌生人共享,且此模式下 `bridge`/弹幕不可用。',
		npWispH: '互联网(wisp)',
		npWispD: '纯出站互联网 — TCP、TLS、WebSocket — 经你自己运行的 wisp 代理。中继上的用户互不可见。',
		npHowRun: '怎么运行一个?',
		npWsUrlErr: '请输入 ws:// 或 wss:// 地址。',
		npWispUrlErr: '请输入 wisp:// 或 wisps:// 地址。',
		npProbe: '测试连接',
		npProbeTesting: '正在测试 WebSocket 握手…',
		npProbeOk: '✓ 中继可以连接。',
		npProbeFailed: '✗ 无法连接 — 请检查地址以及中继是否正在运行。',
		npProbeTimeout:
			'✗ 连接超时 — 中继或网络没有响应。内网地址还可检查浏览器的「本地网络访问」权限' +
			'(chrome://settings/content/localNetworkAccess)以及中间的代理。',
		npProbeMixed: '✗ HTTPS 页面必须使用 wss:// 或 wisps://。',
		npProbePolicy:
			'✗ 此页面框架未获「本地网络访问」权限 — 浏览器会无声挂起这类连接。请刷新页面;' +
			'若依旧,需由外层页面下放 local-network-access 权限。',
		npProbeDenied:
			'✗ 浏览器已对本站屏蔽本地网络访问 — 请在 chrome://settings/content/localNetworkAccess ' +
			'中允许后重试。',
		npProbeInsecure:
			'✗ 本页以 http(非 localhost)打开,不是安全上下文 — Chrome 不会弹出「本地网络访问」' +
			'授权,直接静默拦截。请改用 https 打开(开发环境:`npm run dev:https`)或经 ' +
			'localhost 访问后重试。',
		npCancel: '取消',
		npSave: '保存',
		npSaveReload: '保存并重载',
		npSaved: '已保存',

		npBridgeTitle: '桥接到朋友',
		npBridgeIntro:
			'跨浏览器同一局域网:开个房间,朋友输入房间码,所有机器同网段 — 跨互联网 ' +
			'`ping`、`nc`、`httpd`,`bridge say` 发弹幕。也可在终端里:`bridge start`。',
		npManageBridge: '管理桥接…',
		npClose: '关闭',
		npBridgeOffHub:
			'本机网卡此刻接在 relay 网络上,桥接到不了它——先在网络设置切回局域网(保存并重载),再回这里桥接。',
		npStillUp: '桥接仍在运行 — 此模式下本机将离开被桥接网段',
		npHostRoom: '开个房间',
		npHaveCode: '我有房间码',
		npRoomCodePh: '房间码',
		npBack: '返回',
		npJoin: '加入',
		npConnecting: '正在连接房间 {0}…',
		npBridgedOne: '已桥接 — 两侧局域网已是同一网段',
		npCodeTitle: '房间码 — 念给朋友即可',
		npCopyTitle: '复制房间码',
		npCopy: '复制',
		npDisconnect: '断开',
		npHostTag: '房主',
		npWaitFriends: '等朋友加入 — 让他们输入:',
		npClosed: '桥接已关闭',
		npReset: '重置',

		npCreateInvite: '生成邀请码',
		npHaveInvite: '我有邀请码',
		npPasteInvite: '粘贴对方的邀请码…',
		npMakeAnswer: '生成我的应答码',
		npSendInvite: '把这段邀请码发给对方,再把对方的应答码粘贴到下面。',
		npSendAnswer: '把这段应答码发回给对方;对方粘贴后桥接即建立。',
		npPasteAnswer: '粘贴对方的应答码…',
		npConnect: '连接',
		npWaitOther: '等待对方…',

		npSigRoomH: '房间码',
		npSigRoomD:
			'六个字母,念给对方即可。房间码经公共 Nostr 中继加密传递;STUN 帮双方发现地址。二者都不经手你的流量。',
		npSigManualH: '手动桥接',
		npSigManualD: '完全不走中继:配对码由你自己传递 — 聊天、邮件均可。一次桥一位朋友。',
		npAdvSummary: '高级:中继与 ICE',
		npAdvD:
			'房间码经公共 Nostr 中继传递 — 已加密,只承载握手,不经手你的流量。可替换为你自己的列表。',
		npAdvIceD:
			'WebRTC 握手用的 ICE 服务器:`stun:` 负责发现地址;你自备的 `turn:` 在其他路都不通时' +
			'中转流量 — 写法 `turn:host:3478|用户|密码`。留空恢复默认。',

		npDgVmTab: 'VM · 标签页',
		npDgHub: '同源共享一个 hub',
		npDgNoNet: '不通互联网',
		npDgWisp: 'wisp 中继',
		npDgWsproxy: 'wsproxy 中继',
		npDgOthers: '其他人',
		npDgWsNote: '透传以太网帧 — 同一中继上的所有人同一网段',
		npDgWispNote: '只传 TCP/UDP 负载 — 节点之间互不可见',
		npDgNet: '互联网',
		npDgYourHub: '你的 hub',
		npDgTheirHub: '对方的 hub',
		npDgP2P: 'WebRTC — 点对点,同一网段',
		npDgCodeRelay: '房间码中继',
		npDgRoomNote: '中继只传房间码,STUN 只找地址 — 都不经手流量',
		npDgCarry: '配对码由你传递(聊天/邮件)',
		npDgManualNote: '同一内网零外部依赖;跨互联网时仍借 STUN 找地址',

		npFabTitle: '网络:{0} — 点击更改',
		npChipTitle: '网络设置',
		npDisconnected: '掉线',
		npRelayDownTitle: '中继已断开 — 打开网络设置检查地址',

		npPromptMsg: '虚拟机还没联网 — 一键经 v86 官方公共中继(wsproxy)上网。',
		npPromptGo: '一键联网',
		npPromptStay: '保持局域网',

		bootDownload: '正在下载系统镜像…',
		bootKernel: '正在启动 Linux…',
		bootRestore: '正在唤醒已保存的系统…',
		bootSlow: '启动比平时慢,已显示控制台输出…',
		bootPlayHint: '等待时按空格玩一局',
		bootFailedTitle: 'Linux 虚拟机没有启动成功',
		bootCopyDiag: '复制诊断信息',
		bootCopied: '已复制 — 可直接粘贴反馈',
		bootRetry: '重试',
	},
};

const lang: 'en' | 'zh' = (navigator.language || 'en').startsWith('zh') ? 'zh' : 'en';

export function t(key: string): string {
	return I18N[lang][key] ?? I18N.en[key] ?? key;
}

export function tf(key: string, ...args: (string | number)[]): string {
	let s = t(key);
	for (let i = 0; i < args.length; i++) s = s.replaceAll(`{${i}}`, String(args[i]));
	return s;
}
