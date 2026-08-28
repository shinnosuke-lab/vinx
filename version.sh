#!/usr/bin/env bash

# The single source of truth for the project's name, version, and the page's
# defaults. web/vite.config.ts reads this file as text (it is not executed
# there), and CI echoes the summary below into its logs.
NAME=vinx
VER=0.2.0
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

# What the page starts with when nobody has configured an endpoint: the
# settings panel is seeded with this on first load and is authoritative
# afterwards, so changing these does not move a browser that has already been
# used. Read by web/vite.config.ts and baked into the bundle.
#
# The bundle is served as plain static files, so anyone who can open the page
# can read anything baked in here. DEFAULT_API_KEY must therefore stay empty
# in anything published: the page then opens its settings panel and asks,
# which is the upstream behaviour.
DEFAULT_BASE_URL=
DEFAULT_MODEL=
DEFAULT_API_KEY=

echo "========================================"
echo " NAME:        $NAME"
echo " VER:         $VER"
echo " NAME_VER:    $NAME_VER"
echo " SKILLS_REPO: ${SKILLS_REPO:-(none: the market tab is hidden)}"
echo " MODEL:       ${DEFAULT_MODEL:-(none)} at ${DEFAULT_BASE_URL:-(none)}"
# Counted, not printed: this summary is echoed into every CI log.
if [ -n "$DEFAULT_API_KEY" ]; then
	echo " API KEY:     set, ${#DEFAULT_API_KEY} chars (not printed)"
else
	echo " API KEY:     (none: the page will ask for one)"
fi
echo "========================================"
