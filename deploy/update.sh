#!/usr/bin/env bash
# 拉取最新代码；只有工作台代码变化时才重启服务，技能改动靠热重载。
# 用法：bash deploy/update.sh
set -euo pipefail

APP_DIR="${ECOM_APP_DIR:-/opt/ecom/ecom-workbench}"
SKILLS_DIR="${ECOM_SKILLS_DIR:-/opt/ecom/ecom-skills}"
RESTART_CMD="${ECOM_RESTART_CMD:-sudo systemctl restart ecom-workbench}"
BRANCH="${ECOM_BRANCH:-main}"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "找不到工作台仓库：$APP_DIR" >&2
  exit 1
fi

before="$(git -C "$APP_DIR" rev-parse HEAD)"
git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
git -C "$APP_DIR" reset --hard --quiet "origin/$BRANCH"

if [ -d "$SKILLS_DIR/.git" ]; then
  git -C "$SKILLS_DIR" fetch --quiet origin "$BRANCH"
  git -C "$SKILLS_DIR" reset --hard --quiet "origin/$BRANCH"
fi

after="$(git -C "$APP_DIR" rev-parse HEAD)"
if [ "$before" = "$after" ]; then
  echo "工作台没有变化"
  exit 0
fi

# skills/ 之外的文件变了才需要重启；只改技能时，工作台会自己热重载
changed="$(git -C "$APP_DIR" diff --name-only "$before" "$after" || true)"
if printf '%s\n' "$changed" | grep -qv '^skills/'; then
  echo "工作台代码有更新，重启服务..."
  eval "$RESTART_CMD"
else
  echo "只有技能有更新，工作台会自动热重载"
fi
