#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in ''|--smoke) ;; *) exit 2 ;; esac
ctf-python list

for environment in pydash gradio; do
    test -d "$(ctf-python source "$environment")"
    ctf-python run "$environment" -m pip check
done

ctf-python run pydash - <<'PY'
import inspect
import pydash
assert pydash.__version__ == '8.1.0'
value = {}
pydash.set_(value, 'nested.items[0].name', 'offline')
assert pydash.get(value, 'nested.items[0].name') == 'offline'
assert 'def to_path' in inspect.getsource(pydash.to_path)
print('pydash 8.1.0 path operations / local source: OK')
PY

ctf-python run gradio - <<'PY'
import inspect
import gradio as gr
from fastapi.testclient import TestClient
assert gr.__version__ == '4.12.0'
assert 'class App' in inspect.getsource(gr.routes.App)
# Self-checks never collect flagged samples, even if the caller enables flagging.
interface = gr.Interface(
    fn=lambda value: 'offline:' + value, inputs='text', outputs='text',
    analytics_enabled=False, allow_flagging='never',
)
with TestClient(gr.routes.App.create_app(interface)) as client:
    config = client.get('/config')
    assert config.status_code == 200 and config.json()['version'] == '4.12.0'
    result = client.post('/api/predict', json={'data': ['ready'], 'fn_index': 0})
    assert result.status_code == 200 and result.json()['data'] == ['offline:ready'], result.text
print('Gradio 4.12.0 config / prediction / local source: OK')
PY

if [ "${1:-}" = --smoke ]; then
    offline_check=$(mktemp -d "$HOME/ctf-offline-python-check.XXXXXX")
    trap 'rm -rf "$offline_check"' EXIT
    for environment in pydash gradio; do
        if ! ctf-python create "$environment" "$offline_check/$environment" \
            > "$offline_check/$environment.log" 2>&1; then
            cat "$offline_check/$environment.log" >&2
            exit 1
        fi
        GRADIO_ANALYTICS_ENABLED=False HF_HUB_OFFLINE=1 \
            "$offline_check/$environment/bin/python" -c "import $environment; print('$environment offline reinstall:', $environment.__version__)"
    done
    printf 'Bundled wheel dependencies / fresh offline venvs: OK\n'
fi
