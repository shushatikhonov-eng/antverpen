#!/usr/bin/env bash
# =====================================================================
# КОД АНТВЕРПЕНА — загрузка игры на GitHub Pages
#
# Что делает:
#   1) спрашивает ник GitHub и имя репозитория (или берёт из переменных окружения);
#   2) если установлен GitHub CLI (gh) и вы залогинены — сам создаёт репозиторий
#      и включает GitHub Pages;
#   3) иначе проверяет репозиторий и даёт ссылку, где включить Pages двумя кликами;
#   4) пушит игру и ждёт, пока сайт откроется, затем печатает адрес.
#
# Использование:
#   ./deploy.sh                       # интерактивно
#   GH_USER=ivan GH_REPO=kod-antverpena ./deploy.sh   # без вопросов
#
# Повторный запуск обновляет сайт (пушит новый коммит).
# =====================================================================
set -euo pipefail

cd "$(dirname "$0")"

command -v git >/dev/null || { echo "Нужен git: https://git-scm.com"; exit 1; }

# ---------- gh CLI (необязательно) ----------
GH_OK="no"
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then GH_OK="yes"; fi
fi

# ---------- вопросы ----------
GH_USER="${GH_USER:-}"
GH_REPO="${GH_REPO:-}"
if [ -z "$GH_USER" ] && [ "$GH_OK" = "yes" ]; then
  GH_USER="$(gh api user -q .login 2>/dev/null || true)"
fi
if [ -z "$GH_USER" ]; then
  read -r -p "Ник на GitHub (например, ivanov): " GH_USER
fi
if [ -z "$GH_REPO" ]; then
  read -r -p "Имя репозитория [kod-antverpena]: " GH_REPO
  GH_REPO="${GH_REPO:-kod-antverpena}"
fi
GH_USER="$(echo "$GH_USER" | tr -d ' ' | tr 'A-Z' 'a-z')"
GH_REPO="$(echo "$GH_REPO" | tr -d ' ' | tr 'A-Z' 'a-z')"
SITE_URL="https://${GH_USER}.github.io/${GH_REPO}/"
REMOTE="https://github.com/${GH_USER}/${GH_REPO}.git"

echo ""
echo "→ Репозиторий: ${REMOTE}"
echo "→ Сайт будет:  ${SITE_URL}"
echo ""

# ---------- git ----------
if [ ! -d .git ]; then
  git init -b main >/dev/null
fi
git config user.name  >/dev/null 2>&1 || git config user.name  "${GH_USER}"
git config user.email >/dev/null 2>&1 || git config user.email "${GH_USER}@users.noreply.github.com"

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

git add -A
if git diff --cached --quiet; then
  echo "→ Изменений нет, просто перепушим текущий коммит"
else
  git commit -m "Код Антверпена: детективная игра по реальному делу (Антверпен, 2003)" >/dev/null
fi

# ---------- создание репозитория ----------
if [ "$GH_OK" = "yes" ]; then
  echo "→ gh CLI найден: создаю репозиторий и включаю Pages автоматически"
  gh repo view "$GH_USER/$GH_REPO" >/dev/null 2>&1 || gh repo create "$GH_USER/$GH_REPO" --public --disable-wiki >/dev/null
else
  echo "→ Проверяю репозиторий…"
  if git ls-remote "$REMOTE" >/dev/null 2>&1; then
    echo "→ Репозиторий существует"
  else
    echo ""
    echo "  Репозиторий ещё не создан. Создайте его за 20 секунд:"
    echo "  1. Откройте https://github.com/new"
    echo "  2. Repository name: ${GH_REPO}"
    echo "  3. Public → Create repository (БЕЗ README и .gitignore)"
    echo ""
    read -r -p "  Создали? Enter — продолжить, Ctrl+C — отмена: " _
  fi
fi

# ---------- публикация ----------
echo "→ Публикую…"
if git push -u origin main 2>/dev/null; then
  :
else
  echo "→ Обычный пуш не прошёл, пробую с --force (обновление сайта)"
  git push -u --force origin main
fi

# ---------- включение Pages ----------
if [ "$GH_OK" = "yes" ]; then
  gh api -X POST "repos/${GH_USER}/${GH_REPO}/pages" \
      -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 || true
  gh api -X PUT "repos/${GH_USER}/${GH_REPO}/pages" \
      -f "build_type=legacy" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 || true
  echo "→ Pages включён (если этого не случилось ранее)"
else
  echo ""
  echo "  Включите GitHub Pages (один раз, два клика):"
  echo "  1. Откройте https://github.com/${GH_USER}/${GH_REPO}/settings/pages"
  echo "  2. Source: «Deploy from a branch»"
  echo "  3. Branch: «main», папка: «/ (root)» → Save"
  echo ""
  read -r -p "  Включили? Enter — продолжить: " _
fi

# ---------- ожидание сайта ----------
echo ""
echo "→ Жду сайт (до 3 минут)…"
for i in $(seq 1 36); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "$SITE_URL" || true)"
  if [ "$CODE" = "200" ]; then
    echo ""
    echo "=============================================================="
    echo "  ИГРА ОПУБЛИКОВАНА:  ${SITE_URL}"
    echo "=============================================================="
    echo ""
    echo "  Вечеринка:"
    echo "  1. ТВ: откройте браузер Samsung (кнопка INTERNET/WWW), введите адрес,"
    echo "     выберите «ЭКРАН СЛЕДОВАТЕЛЯ»."
    echo "  2. Телефон: отсканируйте QR с экрана ТВ — пульт подключится сам."
    echo "  Приятной игры!"
    exit 0
  fi
  sleep 5
done

echo "Сайт пока не открылся (GitHub иногда собирает его до 10 минут)."
echo "Через пару минут проверьте: ${SITE_URL}"
echo "Если 404 — проверьте шаг включения Pages выше."
