#!/usr/bin/env bash
set -euo pipefail
set +x
[[ "$GITHUB_SERVER_URL" == https://github.com ]]
[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]]
[[ "$(git remote get-url origin)" == "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git" ]]
: "${LLT_CHECKOUT_TOKEN:?Read-only repository token is required}"
authorization=$(printf 'x-access-token:%s' "$LLT_CHECKOUT_TOKEN" | base64 -w 0)
printf '::add-mask::%s\n' "$authorization"
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=http.https://github.com/.extraheader
export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $authorization"
export GIT_TERMINAL_PROMPT=0
# Credentials are process environment only; never written into .git/config.
git -c credential.helper= fetch --no-recurse-submodules origin '+refs/heads/main:refs/remotes/origin/main'
unset authorization LLT_CHECKOUT_TOKEN GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
git merge-base --is-ancestor "$GITHUB_SHA" origin/main
