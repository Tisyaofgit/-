"""Small specialized leaves using the shared transaction, time and effect services."""
from __future__ import annotations
from matrix_io import EngineError


def install(engine):
    def payment(ctx):
        rid=engine._find('X_FINANCIAL_TERMS',ctx['term']);v=engine._record('X_FINANCIAL_TERMS',rid)['values']
        if v.get('status')=='paid':raise EngineError('TERM_PAID','This payment term is already paid')
        if v.get('amount') is None or v.get('paid') is None:raise EngineError('TERM_AMOUNT','Amount and paid amount must be explicit')
        remaining=v['amount']-v['paid'];amount=ctx.get('amount',remaining)
        if amount<=0 or amount>remaining:raise EngineError('TERM_AMOUNT','Payment amount must be positive and not exceed the balance')
        unit=v.get('currency_ref')
        if not unit:raise EngineError('TERM_CURRENCY','Payment currency is missing')
        debit=ctx.get('debit_target') or v['debtor_ref']+'.wallet/'+unit;credit=ctx.get('credit_target') or v['creditor_ref']+'.wallet/'+unit
        if engine.get(debit)<amount:raise EngineError('INSUFFICIENT_CURRENCY','Payer has insufficient funds')
        engine.delta(debit,-amount);engine.delta(credit,amount);engine.set(f'X_FINANCIAL_TERMS#{rid}.paid',v['paid']+amount)
        engine.set(f'X_FINANCIAL_TERMS#{rid}.status','paid' if amount==remaining else 'partial')
        return {'term':rid,'paid_amount':amount,'currency':unit}
    def depart(ctx):
        rid=engine._find('X_JOURNEYS',ctx['journey']);v=engine._record('X_JOURNEYS',rid)['values']
        if v.get('status')!='planned':raise EngineError('JOURNEY_STATE','Journey must be planned before departure')
        if v.get('departure_at') is None or v.get('arrival_at') is None:raise EngineError('JOURNEY_TIME','Departure and arrival times are required')
        if v['arrival_at']<v['departure_at']:raise EngineError('JOURNEY_TIME','Arrival precedes departure')
        if engine._clock().ordinal()<v['departure_at']:raise EngineError('JOURNEY_TIME','Departure time has not arrived')
        engine.effects(v.get('cost') or [],{'actor':v['actor_ref']});engine.set(f'X_JOURNEYS#{rid}.status','in_transit');return {'journey':rid,'status':'in_transit'}
    def arrive(ctx):
        rid=engine._find('X_JOURNEYS',ctx['journey']);v=engine._record('X_JOURNEYS',rid)['values']
        if v.get('status')!='in_transit':raise EngineError('JOURNEY_STATE','Journey is not in transit')
        if engine._clock().ordinal()<v['arrival_at']:raise EngineError('JOURNEY_TIME','Journey has not arrived')
        engine.effects(v.get('arrival_effects') or [],{'actor':v['actor_ref']})
        if ctx.get('destination') is not None:engine.set(v['actor_ref']+'.'+ctx.get('location_field','location'),ctx['destination'])
        engine.set(f'X_JOURNEYS#{rid}.status','arrived');return {'journey':rid,'status':'arrived'}
    def transmit(ctx):
        rid=engine._find('X_TRANSMISSIONS',ctx['transmission']);v=engine._record('X_TRANSMISSIONS',rid)['values']
        if v.get('status')=='received':raise EngineError('TRANSMISSION_RECEIVED','Transmission has already been received')
        for k in ['fact_ref','sender_ref','recipient_ref','channel','claimed_content']:
            if v.get(k) is None:raise EngineError('TRANSMISSION_INPUT','Transmission field is missing',field=k)
        engine._record('T_STATIC_FACTS',v['fact_ref'])
        if not ctx.get('epistemic_level'):raise EngineError('KNOWLEDGE_LEVEL','Set the recipient knowledge level explicitly')
        when=engine._clock().ordinal();engine.set(f'X_TRANSMISSIONS#{rid}.received_at',when);engine.set(f'X_TRANSMISSIONS#{rid}.status','received')
        cog=engine.new_record('T_DYN_COGNITION',{'subject_ref':v['recipient_ref'],'target_fact_ref':v['fact_ref'],'epistemic_level':ctx['epistemic_level'],'acquisition_channel':v['channel'],'evidence_nature':'transmission:'+rid,'subjective_belief':v['claimed_content']})
        return {'transmission':rid,'cognition_record':cog,'received_at':when}
    def assign_role(ctx):
        rid=engine._find('X_MEMBERSHIPS',ctx['membership']);v=engine._record('X_MEMBERSHIPS',rid)['values'];at=engine._clock().ordinal()
        if v.get('starts_at') is not None and at<v['starts_at']:raise EngineError('ROLE_TERM','Role term has not started')
        if v.get('ends_at') is not None and at>=v['ends_at']:raise EngineError('ROLE_TERM','Role term has ended')
        if not v.get('subject_ref') or not v.get('organization_ref') or not v.get('role'):raise EngineError('ROLE_INPUT','Member, organization and role are required')
        engine.set(f'X_MEMBERSHIPS#{rid}.status','active');return {'membership':rid,'subject':v['subject_ref'],'role':v['role']}
    def apply_effect(ctx):
        rid=engine._find('X_EFFECT_TYPES',ctx['effect']);t=engine._record('X_EFFECT_TYPES',rid)['values'];subject=ctx.get('subject') or ctx.get('actor');at=engine._clock().ordinal()
        if not subject:raise EngineError('EFFECT_SUBJECT','Effect subject is missing')
        if t.get('duration_minutes') is None or t['duration_minutes']<0:raise EngineError('EFFECT_DURATION','Set a nonnegative effect duration')
        stacking=t.get('stacking')
        if stacking not in {'replace','extend','stack'}:raise EngineError('EFFECT_STACKING','Set replace, extend or stack explicitly')
        current=[(i,r['values']) for i,r in engine.rows('X_EFFECT_INSTANCES').items() if r['values'].get('effect_ref')==rid and r['values'].get('subject')==subject and r['values'].get('status')=='active']
        if len(current)>1:raise EngineError('EFFECT_DUPLICATE','Multiple active instances need an explicit stacking relation')
        if current and stacking=='extend':
            i,v=current[0];engine.set(f'X_EFFECT_INSTANCES#{i}.expires_at',max(at,v['expires_at'])+t['duration_minutes']);return {'instance':i,'stacking':'extend'}
        if current and stacking=='stack':
            i,v=current[0];engine.delta(f'X_EFFECT_INSTANCES#{i}.stacks',1);engine.effects(t.get('on_apply') or [],{'actor':subject});return {'instance':i,'stacking':'stack'}
        for i,v in current:
            for _ in range(v.get('stacks') or 1):engine.effects(t.get('on_expire') or [],{'actor':subject})
            engine.set(f'X_EFFECT_INSTANCES#{i}.status','replaced')
        engine.effects(t.get('on_apply') or [],{'actor':subject});interval=t.get('interval_minutes')
        if interval is not None and interval<=0:raise EngineError('EFFECT_INTERVAL','Periodic interval must be positive')
        values={'effect_ref':rid,'subject':subject,'started_at':at,'expires_at':at+t['duration_minutes'],'stacks':1,'status':'active'}
        if interval is not None:values['next_tick_at']=at+interval
        instance=engine.new_record('X_EFFECT_INSTANCES',values);return {'instance':instance,'expires_at':values['expires_at']}
    def tick_effects(start,end):
        completed=[]
        for rid,rec in list(engine.rows('X_EFFECT_INSTANCES').items()):
            v=rec['values']
            if v.get('status')!='active':continue
            typ=engine._record('X_EFFECT_TYPES',v['effect_ref'])['values'];until=v['expires_at'];period=typ.get('interval_minutes')
            if period is not None:
                while v.get('next_tick_at') is not None and v['next_tick_at']<=end and v['next_tick_at']<until:
                    for _ in range(v.get('stacks') or 1):engine.effects(typ.get('on_tick') or [],{'actor':v['subject']})
                    engine.set(f'X_EFFECT_INSTANCES#{rid}.next_tick_at',v['next_tick_at']+period)
            if until<=end:
                for _ in range(v.get('stacks') or 1):engine.effects(typ.get('on_expire') or [],{'actor':v['subject']})
                engine.set(f'X_EFFECT_INSTANCES#{rid}.status','expired');completed.append(rid)
        return completed
    engine.operators.update({'PAY_TERM':payment,'DEPART':depart,'ARRIVE':arrive,'TRANSMIT':transmit,'ASSIGN_ROLE':assign_role,'APPLY_EFFECT':apply_effect})
    engine.clock_listeners.append(tick_effects)
