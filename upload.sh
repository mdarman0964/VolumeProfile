#!/data/data/com.termux/files/usr/bin/bash

set -e

REPO="mdarman0964/VolumeProfile"
USER="mdarman0964"
BRANCH="main"

echo "=== GitHub Upload Script ==="

if [ ! -d .git ]; then
    echo "Git repository not initialized!"
    exit 1
fi

git config user.name "$USER"
git config user.email "mdarman0964@gmail.com"

if ! git remote get-url origin >/dev/null 2>&1; then
    git remote add origin "https://github.com/$REPO.git"
fi

echo "Checking files..."
git add .

if ! git diff --cached --quiet; then
    git commit -m "Upload project files"
else
    echo "No new changes to commit."
fi

echo "Checking remote branch..."
REMOTE_SHA=$(git ls-remote --heads origin "$BRANCH" | awk 'NR==1 {print $1}')

if [ -n "$REMOTE_SHA" ]; then
    echo "Remote branch found. Fetching..."
    git fetch origin "$BRANCH"

    if ! git merge "origin/$BRANCH" --allow-unrelated-histories --no-edit; then
        echo "Merge conflict detected. Resolve conflicts before uploading."
        exit 1
    fi
else
    echo "Remote branch is empty. Direct upload will be attempted."
fi

echo "Enter your NEW GitHub token:"
read -rsp "Token: " GITHUB_TOKEN
echo

if [ -z "$GITHUB_TOKEN" ]; then
    echo "Token is empty!"
    exit 1
fi

ASKPASS=$(mktemp)
trap 'rm -f "$ASKPASS"; unset GITHUB_TOKEN' EXIT

cat > "$ASKPASS" <<'ASK'
#!/data/data/com.termux/files/usr/bin/sh
case "$1" in
  *Username*) echo "mdarman0964" ;;
  *Password*) echo "$GITHUB_TOKEN" ;;
  *) exit 1 ;;
esac
ASK

chmod 700 "$ASKPASS"

echo "Uploading files to GitHub..."

GIT_ASKPASS="$ASKPASS" \
GIT_TERMINAL_PROMPT=0 \
git -c credential.helper= push -u origin "$BRANCH"

echo "=== UPLOAD SUCCESSFUL ==="
echo "Repository: https://github.com/$REPO"
