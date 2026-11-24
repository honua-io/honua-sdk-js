export const fakeGh = `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" != "api" ]]; then
  echo "unexpected gh command: $*" >&2
  exit 2
fi
shift
method="GET"
endpoint=""
input=""
paginate=0
fields=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --method|-X) method="$2"; shift 2 ;;
    --input) input="$2"; shift 2 ;;
    --raw-field|-f) fields+=("$2"); shift 2 ;;
    --paginate) paginate=1; shift ;;
    --slurp|--include|-i)
      echo "unexpected gh flag: $1" >&2
      exit 2
      ;;
    *)
      if [[ "$1" == -* ]]; then
        echo "unexpected gh flag: $1" >&2
        exit 2
      fi
      endpoint="$1"
      shift
      ;;
  esac
done
body=""
if [[ "\${input}" == "-" ]]; then
  body="$(cat)"
fi
field_json="[]"
if [[ \${#fields[@]} -gt 0 ]]; then
  field_json=$(printf '%s\\n' "\${fields[@]}" | jq -R . | jq -s .)
fi
jq -nc --arg method "$method" --arg endpoint "$endpoint" --arg body "$body" --argjson paginate "$paginate" --argjson fields "$field_json" \\
  '{method:$method, endpoint:$endpoint, body:$body, paginate:($paginate == 1), fields:$fields}' >> "$GH_FAKE_LOG"
if [[ "$endpoint" == *search* ]]; then
  echo "search endpoint used: $endpoint" >&2
  exit 2
fi
if [[ "$method" == "GET" ]]; then
  [[ "$paginate" == 1 ]] || { echo "issue list was not paginated" >&2; exit 2; }
  [[ -f "$GH_LIST_FILE" ]] || { echo "missing issue list" >&2; exit 2; }
  cat "$GH_LIST_FILE"
  exit "\${GH_LIST_STATUS:-0}"
fi
if [[ "$method" == "POST" || "$method" == "PATCH" ]]; then
  printf '%s\\n' '{"number":1}'
  exit 0
fi
echo "unexpected gh api call: $method $endpoint" >&2
exit 2
`;
