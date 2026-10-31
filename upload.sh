#!/data/data/com.termux/files/usr/bin/bash
set -e

ASKPASS=$(mktemp)
cleanup() {
    rm -f "$ASKPASS"
    unset GITHUB_TOKEN
}
trap cleanup EXIT

echo "GitHub Username: mdarman0964"
read -rsp "New GitHub Token: " GITHUB_TOKEN
echo

if [ -z "$GITHUB_TOKEN" ]; then
    echo "Token missing!"
    exit 1
fi

export GITHUB_TOKEN

cat > "$ASKPASS" <<'ASK'
#!/data/data/com.termux/files/usr/bin/sh
case "$1" in
    *Username*) printf '%s\n' "mdarman0964" ;;
    *Password*) printf '%s\n' "$GITHUB_TOKEN" ;;
    *) exit 1 ;;
esac
ASK

chmod 700 "$ASKPASS"

git add .

if ! git diff --cached --quiet; then
    git commit -m "Upload project"
fi

GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 \
git -c credential.helper= push -u origin main

echo "Upload successful!"
