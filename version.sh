#!/usr/bin/env bash

# The single source of truth for the project's name, version, and the page's
# defaults. web/vite.config.ts reads this file as text (it is not executed
# there), and CI echoes the summary below into its logs.
NAME=vinx
VER=0.2.1
NAME_VER=$NAME.$VER

# A skills repository: an index.json and the packages it names, served as
# plain static files (agent-core's docs/SKILLS_REPO.md). Not versioned with
# the page -- skills outlive builds.
#
# The page downloads packages itself rather than through a proxy, so the host
# has to send Access-Control-Allow-Origin for the index and the packages both.
#
# Empty hides the market tab: /api/skills/market then answers 404, which the
# chat UI reads as "this agent has no repository". Uploading a package by hand
# keeps working either way.
SKILLS_REPO=${SKILLS_REPO:-}

# An apps repository (apps-hub): an index.json and the .vapp packages it
# names. The page keeps only entries whose env lists "vinx" -- the hub
# serves every runtime. Empty hides the Apps page's repository tab the
# same way SKILLS_REPO does the skills market.
APPS_REPO=${APPS_REPO:-}

# What the page starts with when nobody has configured an endpoint: the
# settings panel is seeded with this on first load and is authoritative
# afterwards, so changing these does not move a browser that has already been
# used. Read by web/vite.config.ts and baked into the bundle.
#
# The bundle is served as plain static files, so anyone who can open the page
# can read anything baked in here. DEFAULT_API_KEY must therefore stay empty
# in anything published. The published page instead points at the hosted
# proxy in deploy/cloudflare-llm-proxy/: the DeepSeek key lives in that
# Worker's secret, the proxy ignores whatever the page sends as a key, and a
# base_url plus model is all the runtime needs to count as configured — so a
# first-time visitor lands in a working chat with no settings to fill in.
# Empty both to get the upstream behaviour back (the panel opens and asks).
DEFAULT_BASE_URL=https://vinx-llm-proxy.shinnosuke-lab.workers.dev
DEFAULT_MODEL=deepseek-v4-flash
DEFAULT_API_KEY=

# Where this code lives. The page's About popover shows it as the "Source"
# link and points "Check for updates" at its releases page; forks put their
# own repository here, and empty hides both links.
REPO_URL=https://github.com/shinnosuke-lab/vinx

echo "========================================"
echo " NAME:        $NAME"
echo " VER:         $VER"
echo " NAME_VER:    $NAME_VER"
echo " REPO_URL:    ${REPO_URL:-(none: no source link in About)}"
echo " SKILLS_REPO: ${SKILLS_REPO:-(none: the market tab is hidden)}"
echo " MODEL:       ${DEFAULT_MODEL:-(none)} at ${DEFAULT_BASE_URL:-(none)}"
# Counted, not printed: this summary is echoed into every CI log.
if [ -n "$DEFAULT_API_KEY" ]; then
	echo " API KEY:     set, ${#DEFAULT_API_KEY} chars (not printed)"
elif [ -n "$DEFAULT_BASE_URL" ]; then
	echo " API KEY:     (none: the endpoint above holds its own)"
else
	echo " API KEY:     (none: the page will ask for one)"
fi
echo "========================================"
