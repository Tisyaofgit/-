"""Explicit formula language and world time. No Python eval or fixed pass limit."""
from __future__ import annotations
import ast, calendar, math, operator, re
from decimal import Decimal, ROUND_HALF_UP
from matrix_io import EngineError


def excel_round(value,digits=0):
    return float(Decimal(str(value)).quantize(Decimal(10)**(-int(digits)),rounding=ROUND_HALF_UP))


def transform_formula(text,current_sheet):
    text=text.lstrip('=');out=[];i=0
    cell=r'\$?[A-Za-z]{1,3}\$?\d+'
    while i<len(text):
        c=text[i]
        if c in "\"'":
            q=c;j=i+1
            while j<len(text):
                if text[j]=='\\':j+=2;continue
                if text[j]==q:
                    if j+1<len(text) and text[j+1]==q:j+=2;continue
                    break
                j+=1
            if j>=len(text):raise EngineError('FORMULA_STRING','Unclosed quoted text')
            sheet=text[i+1:j].replace(q+q,q)
            if j+1<len(text) and text[j+1]=='!':
                m=re.match(cell,text[j+2:])
                if not m:raise EngineError('FORMULA_COORDINATE','Invalid quoted-sheet reference')
                ref=f'{sheet}!{m[0]}';end=j+2+len(m[0]);r=re.match(':'+cell,text[end:])
                if r:out.append(f'RANGE({ref!r},{(sheet+"!"+r[0][1:])!r})');end+=len(r[0])
                else:out.append(f'CELL({ref!r})')
                i=end;continue
            # Excel doubled quotation marks are represented as normal Python strings.
            out.append(repr(sheet));i=j+1;continue
        m=re.match(r'([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*)!('+cell+r')',text[i:])
        local=None if m else re.match(cell,text[i:])
        if local and i>0 and (text[i-1].isalnum() or text[i-1]=='_'):local=None
        if m or local:
            token=m[0] if m else f'{current_sheet}!{local[0]}';end=i+len(m[0] if m else local[0]);r=re.match(':'+cell,text[end:])
            if r:out.append(f'RANGE({token!r},{(token.split("!")[0]+"!"+r[0][1:])!r})');end+=len(r[0])
            else:out.append(f'CELL({token!r})')
            i=end;continue
        if text[i:i+2]=='<>':out.append('!=');i+=2;continue
        if c=='=' and (not out or text[i-1] not in '<>=!') and (i+1>=len(text) or text[i+1]!='='):out.append('==');i+=1;continue
        if c=='^':out.append('**')
        else:out.append(c)
        i+=1
    return ''.join(out)


class Formula:
    BIN={ast.Add:operator.add,ast.Sub:operator.sub,ast.Mult:operator.mul,ast.Div:operator.truediv,ast.FloorDiv:operator.floordiv,ast.Mod:operator.mod,ast.Pow:operator.pow,ast.BitAnd:lambda a,b:str(a)+str(b)}
    CMP={ast.Eq:operator.eq,ast.NotEq:operator.ne,ast.Lt:operator.lt,ast.LtE:operator.le,ast.Gt:operator.gt,ast.GtE:operator.ge,ast.In:lambda a,b:a in b,ast.NotIn:lambda a,b:a not in b,ast.Is:operator.is_,ast.IsNot:operator.is_not}
    def __init__(self,functions=None,names=None):self.functions=functions or {};self.names=names or {}
    def evaluate(self,text,current_sheet=''):
        try:
            tree=ast.parse(transform_formula(text,current_sheet),mode='eval');v=self.visit(tree.body)
            if isinstance(v,float) and not math.isfinite(v):raise EngineError('NONFINITE','Formula result is nonfinite')
            return int(v) if isinstance(v,float) and v.is_integer() else v
        except EngineError:raise
        except Exception as exc:raise EngineError('FORMULA_ERROR',str(exc),formula=text,error_type=type(exc).__name__) from exc
    def visit(self,n):
        if isinstance(n,ast.Constant):return n.value
        if isinstance(n,(ast.List,ast.Tuple)):return [self.visit(x) for x in n.elts]
        if isinstance(n,ast.Dict):return {self.visit(k):self.visit(v) for k,v in zip(n.keys,n.values)}
        if isinstance(n,ast.Name):
            if n.id.upper() in {'TRUE','FALSE'}:return n.id.upper()=='TRUE'
            if n.id in self.names:return self.names[n.id]
            raise EngineError('FORMULA_NAME','Unknown formula name',name=n.id)
        if isinstance(n,ast.UnaryOp):
            v=self.visit(n.operand)
            if isinstance(n.op,ast.USub):return -v
            if isinstance(n.op,ast.UAdd):return +v
            if isinstance(n.op,ast.Not):return not v
        if isinstance(n,ast.BinOp) and type(n.op) in self.BIN:return self.BIN[type(n.op)](self.visit(n.left),self.visit(n.right))
        if isinstance(n,ast.BoolOp):
            if isinstance(n.op,ast.And):return all(self.visit(x) for x in n.values)
            if isinstance(n.op,ast.Or):return any(self.visit(x) for x in n.values)
        if isinstance(n,ast.Compare):
            left=self.visit(n.left)
            for op,r in zip(n.ops,n.comparators):
                right=self.visit(r)
                if type(op) not in self.CMP or not self.CMP[type(op)](left,right):return False
                left=right
            return True
        if isinstance(n,ast.IfExp):return self.visit(n.body if self.visit(n.test) else n.orelse)
        if isinstance(n,ast.Subscript):return self.visit(n.value)[self.visit(n.slice)]
        if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and not n.keywords:
            name=n.func.id.upper()
            if name=='IF':
                if len(n.args)!=3:raise EngineError('ARITY','IF needs three arguments')
                return self.visit(n.args[1] if self.visit(n.args[0]) else n.args[2])
            if name in {'AND','OR'}:return all(self.visit(x) for x in n.args) if name=='AND' else any(self.visit(x) for x in n.args)
            if name=='IFERROR':
                try:return self.visit(n.args[0])
                except (EngineError,ArithmeticError):return self.visit(n.args[1])
            basic={'MIN':lambda *a:min(self.flatten(a)),'MAX':lambda *a:max(self.flatten(a)),'SUM':lambda *a:sum(self.numbers(a)),'AVERAGE':lambda *a:sum(self.numbers(a))/len(self.numbers(a)),'COUNT':lambda *a:len(self.numbers(a)),'ABS':abs,'INT':math.floor,'ROUND':excel_round,'NOT':lambda x:not x,'LEN':len,'TEXT':str}
            f=self.functions.get(name) or basic.get(name)
            if f is None:raise EngineError('FORMULA_FUNCTION','Unknown formula function',name=name)
            return f(*[self.visit(x) for x in n.args])
        raise EngineError('FORMULA_SYNTAX','Unsupported expression construct',construct=type(n).__name__)
    @staticmethod
    def flatten(values):
        out=[]
        for x in values:
            if isinstance(x,(list,tuple)):out+=Formula.flatten(x)
            elif x is not None:out.append(x)
        return out
    @staticmethod
    def numbers(values):return [x for x in Formula.flatten(values) if isinstance(x,(int,float)) and not isinstance(x,bool)]


class WorldClock:
    def __init__(self,config):
        if not config:raise EngineError('MISSING_CALENDAR','Configure the world calendar before advancing time')
        self.c=dict(config);self.c.setdefault('mode','SEASON_FIXED');self.c.setdefault('hour_minutes',60);self.c.setdefault('day_hours',24)
        self.c.setdefault('year',1);self.c.setdefault('day',1);self.c.setdefault('hour',0);self.c.setdefault('minute',0)
        if self.c['mode']=='SEASON_FIXED':
            self.c.setdefault('season',1);self.c.setdefault('seasons_per_year',4);self.c.setdefault('days_per_season',30)
        else:self.c.setdefault('month',1)
        self._validate()
    def _validate(self):
        if self.c['mode'] not in {'SEASON_FIXED','MONTH_TABLE','MONTH_FIXED'}:raise EngineError('CALENDAR_MODE','Unsupported calendar mode',mode=self.c['mode'])
        for k in ['hour_minutes','day_hours']:
            if not isinstance(self.c[k],int) or self.c[k]<=0:raise EngineError('CALENDAR_UNIT','Calendar units must be positive integers',field=k)
        if not 0<=self.c['minute']<self.c['hour_minutes'] or not 0<=self.c['hour']<self.c['day_hours']:raise EngineError('CALENDAR_TIME','Invalid hour/minute')
        if self.c['year']<1:raise EngineError('CALENDAR_YEAR','This numbering requires year >= 1')
        lengths=self.lengths(self.c['year']);idx=self.c.get('season',self.c.get('month',1))-1
        if not 0<=idx<len(lengths) or not 1<=self.c['day']<=lengths[idx]:raise EngineError('CALENDAR_DATE','Invalid world date',date=self.c)
    def lengths(self,year):
        if self.c['mode']=='SEASON_FIXED':return [self.c['days_per_season']]*self.c['seasons_per_year']
        if self.c['mode']=='MONTH_FIXED':return [self.c.get('days_per_month',30)]*self.c.get('months_per_year',12)
        result=list(self.c.get('month_lengths') or [31,28,31,30,31,30,31,31,30,31,30,31])
        if self.c.get('leap_rule','GREGORIAN')=='GREGORIAN' and calendar.isleap(year):result[int(self.c.get('leap_month',2))-1]+=1
        return result
    def ordinal(self):
        y=self.c['year'];mode=self.c['mode']
        if mode=='MONTH_TABLE' and self.c.get('leap_rule','GREGORIAN')=='GREGORIAN':days=(y-1)*sum(self.lengths(1))+(y-1)//4-(y-1)//100+(y-1)//400
        else:days=(y-1)*sum(self.lengths(1))
        idx=self.c.get('season',self.c.get('month',1))-1;days+=sum(self.lengths(y)[:idx])+self.c['day']-1
        return (days*self.c['day_hours']+self.c['hour'])*self.c['hour_minutes']+self.c['minute']
    def set_ordinal(self,value):
        if value<0:raise EngineError('TIME_BEFORE_EPOCH','Time precedes configured epoch')
        day_minutes=self.c['day_hours']*self.c['hour_minutes'];days,rem=divmod(int(value),day_minutes);year=max(1,days//sum(self.lengths(1))+1)
        def before(y):
            if self.c['mode']=='MONTH_TABLE' and self.c.get('leap_rule','GREGORIAN')=='GREGORIAN':return (y-1)*sum(self.lengths(1))+(y-1)//4-(y-1)//100+(y-1)//400
            return (y-1)*sum(self.lengths(1))
        while before(year)>days:year-=1
        while before(year+1)<=days:year+=1
        d=days-before(year);lengths=self.lengths(year);period=0
        while d>=lengths[period]:d-=lengths[period];period+=1
        self.c['year']=year;self.c['day']=d+1;self.c['season' if self.c['mode']=='SEASON_FIXED' else 'month']=period+1;self.c['hour'],self.c['minute']=divmod(rem,self.c['hour_minutes']);return self.c
    def duration(self,text):
        if isinstance(text,(int,float)):
            if not float(text).is_integer():raise EngineError('TIME_PRECISION','Tick minutes must be whole')
            return int(text)
        clean=re.sub(r'\s+','',str(text));parts=list(re.finditer(r'([+-]?\d+(?:\.\d+)?)([dhmt天时分刻])',clean,re.I))
        if not parts or ''.join(x[0] for x in parts)!=clean:raise EngineError('TIME_SYNTAX','Use explicit d/h/m/t units',value=text)
        hm=self.c['hour_minutes'];dm=hm*self.c['day_hours'];units={'d':dm,'h':hm,'m':1,'t':self.c.get('tick_minutes',1),'天':dm,'时':hm,'分':1,'刻':self.c.get('tick_minutes',1)}
        v=sum(float(x[1])*units[x[2].lower()] for x in parts)
        if not v.is_integer():raise EngineError('TIME_PRECISION','Tick is smaller than configured minute')
        return int(v)
    def advance(self,delta):
        before=self.ordinal();self.set_ordinal(before+self.duration(delta));return self.ordinal()-before
    def text(self):
        c=self.c
        if c['mode']=='SEASON_FIXED':
            names=c.get('season_names',['春','夏','秋','冬']);season=names[c['season']-1] if c['season']<=len(names) else str(c['season']);return f"第{c['year']}年·{season}·第{c['day']}日 {c['hour']:02d}:{c['minute']:02d}"
        return f"{c['year']:04d}.{c['month']:02d}.{c['day']:02d} {c['hour']:02d}:{c['minute']:02d}"
