"""Bind the UI's canonical reducer to transactional narrative time.

No default hunger, desire, or personal importance is inferred from prose.
Only explicitly registered persona dynamics participate.
"""
import copy
import json
import subprocess
from pathlib import Path
from matrix_io import EngineError

MODEL = Path(__file__).resolve().parents[2] / 'public/js/persona-model.js'

def reduce_persona(state, event):
    try:
        result = subprocess.run(['node', str(MODEL)],
            input=json.dumps({'state': state or {}, 'event': event}),
            text=True, capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise EngineError('PERSONA_RUNTIME', str(exc)) from exc
    if result.returncode:
        raise EngineError('PERSONA_EVENT', result.stderr.strip() or '心性事件处理失败')
    return json.loads(result.stdout)

def apply_event(engine, actor, event):
    record = engine.rows('T_CHAR_DOSSIER').get(actor)
    if record is None:
        raise EngineError('PERSONA_ACTOR', '心性角色记录不存在', actor=actor)
    volumes = copy.deepcopy(record['values'].get('分卷档案') or {})
    persona = volumes.setdefault('persona', {})
    persona['dynamics'] = reduce_persona(persona.get('dynamics'), event)
    engine.set(f'T_CHAR_DOSSIER#{actor}.分卷档案', volumes)
    return {'actor': actor, 'event_id': event['id']}

def install(engine):
    engine.operators['PERSONA_EVENT'] = lambda ctx: apply_event(engine, ctx['actor'], ctx['event'])
    def tick_persona(start, end):
        if end <= start:
            return []
        hours = (end-start) / engine._clock().c['hour_minutes']
        for actor, record in list(engine.rows('T_CHAR_DOSSIER').items()):
            persona = (record['values'].get('分卷档案') or {}).get('persona') or {}
            if persona.get('dynamics'):
                apply_event(engine, actor, {'id': f'world-clock:{start}:{end}', 'kind': 'tick', 'hours': hours})
        return []
    engine.clock_listeners.append(tick_persona)
