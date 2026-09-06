# Shown when the console shell opens (a login shell), not for run_shell tool
# calls (rund runs plain `sh`, which does not source this). The page bakes
# its network choice into the kernel cmdline as vinx.net=<mode>, so the hints
# can tell the truth per mode -- on a wsproxy relay the 10.0.2.x alias never
# crosses the server (it drops source IPs it did not lease), and advising it
# there cost people real debugging time.
case "$-" in
	*i*)
		case " $(cat /proc/cmdline 2>/dev/null) " in
			*' vinx.net=wsproxy '*)
				echo "Relay LAN: the address comes from the relay's DHCP -- ready once 'ip route' shows a default (a few seconds; 'udhcpc -i eth0 -n' nudges a lost lease)."
				echo "Machines on this relay reach each other at those DHCP addresses ('ip -4 addr show eth0'); the 10.0.2.x alias does not cross the relay."
				;;
			*' vinx.net=wisp '*)
				echo "Internet (wisp): outbound TCP works once 'ip route' shows a default; machines on the relay never see each other."
				;;
			*' vinx.net=fetch '*)
				echo "fetch mode: outbound plain HTTP only, replayed as browser fetch() -- CORS applies, no TLS, no peers."
				;;
			*' vinx.net=none '*)
				echo "No network: this machine has no NIC. The page's network control can give it one."
				;;
			*)
				# hub (host/bridge), and any boot without the token.
				_h=$(cat /run/inbrowser-host 2>/dev/null)
				[ -n "$_h" ] && {
					echo "LAN: this VM is 10.0.2.$_h -- open another terminal tab to network two VMs."
					echo "Internet access (none by default) is set in the page's network control."
				}
				unset _h
				;;
		esac
		grep -q ' /data 9p' /proc/mounts 2>/dev/null && \
			echo "Files in /data survive page reloads; everything else is RAM."
		;;
esac
