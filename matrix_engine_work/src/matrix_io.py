"""Header-discovered OOXML matrices. Standard-library reader/writer, no fixed row IDs."""
from __future__ import annotations
import copy, json, math, posixpath, re, uuid, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

MAIN='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PKG='http://schemas.openxmlformats.org/package/2006/relationships'
NS={'s':MAIN,'r':REL}
ET.register_namespace('',MAIN);ET.register_namespace('r',REL)


class EngineError(Exception):
    def __init__(self, code, message, **details):
        super().__init__(message);self.code=code;self.details=details
    def as_dict(self):return {'code':self.code,'message':str(self),'details':self.details}


def col(n):
    s=''
    while n:n,a=divmod(n-1,26);s=chr(65+a)+s
    return s


def colnum(s):
    n=0
    for c in s.upper():n=n*26+ord(c)-64
    return n


def address(s):
    m=re.fullmatch(r'\$?([A-Za-z]+)\$?(\d+)',s)
    if not m:raise EngineError('COORDINATE','Invalid coordinate',coordinate=s)
    return colnum(m[1]),int(m[2])


def parse_header(raw):
    if not isinstance(raw,str) or '|' not in raw:return None
    lines=raw.strip().splitlines();machine=lines[-1]
    bits=machine.split('|');key=bits[0].strip();typ=bits[1].strip().upper() if len(bits)>1 else 'TEXT'
    if not re.fullmatch(r'[\w.\-\u4e00-\u9fff]+',key):return None
    spec={'key':key,'type':typ,'label':lines[0] if len(lines)>1 else key}
    m=re.fullmatch(r'([A-Z_]+)\[([^,]*),([^\]]*)\]',typ)
    if m:
        spec['type']=m[1]
        if m[2]:spec['minimum']=float(m[2])
        if m[3]:spec['maximum']=float(m[3])
    return spec


def decode_value(raw,spec):
    typ=spec.get('type','TEXT').upper()
    if raw is None or raw=='':return None,'unset'
    if isinstance(raw,str) and raw in {'?','~','!','∅','—'}:
        return None,{'?':'unknown','~':'unset','!':'cleared','∅':'none','—':'not_applicable'}[raw]
    if typ in {'NUMBER','INTEGER','INT','DECIMAL','FLOAT','RATIO'}:
        if isinstance(raw,bool):raise EngineError('NUMBER_TYPE','Boolean is not a number',field=spec['key'])
        if isinstance(raw,str):
            g=re.fullmatch(r'([+-]?\d+(?:\.\d+)?)(?:/([+-]?\d+(?:\.\d+)?))?',raw.strip())
            if not g:raise EngineError('NUMBER_TYPE','A numeric field requires a number',field=spec['key'],value=raw)
            raw=float(g[1]) if '.' in g[1] else int(g[1])
        if not isinstance(raw,(int,float)) or not math.isfinite(raw):raise EngineError('NUMBER_TYPE','Finite number required',field=spec['key'])
        if typ in {'INTEGER','INT'} and int(raw)!=raw:raise EngineError('INTEGER_TYPE','Integer required',field=spec['key'])
        for name,pred in [('minimum',lambda v,b:v<b),('maximum',lambda v,b:v>b)]:
            if spec.get(name) is not None and pred(raw,spec[name]):raise EngineError('RANGE','Value outside declared bounds',field=spec['key'],bound=name,value=raw)
        return int(raw) if float(raw).is_integer() else raw,'known'
    if typ in {'BOOL','BOOLEAN'}:
        if isinstance(raw,bool):return raw,'known'
        if str(raw).upper() in {'TRUE','是'}:return True,'known'
        if str(raw).upper() in {'FALSE','否'}:return False,'known'
        raise EngineError('BOOLEAN_TYPE','Use TRUE/FALSE or 是/否',field=spec['key'],value=raw)
    if typ=='BAG':
        if isinstance(raw,dict):bag=raw
        elif str(raw).strip() in {'[]','{}','无','空'}:bag={}
        elif str(raw).lstrip().startswith('{'):bag=json.loads(raw)
        else:
            bag={}
            for p in re.split(r'[;,；，]',str(raw).strip('[] ')):
                if not p.strip():continue
                m=re.fullmatch(r'(.+?)(?:[×*]\s*([0-9]+(?:\.[0-9]+)?))?',p.strip())
                if not m:raise EngineError('BAG_SYNTAX','Invalid bag item',value=p)
                name=m[1].strip();q=float(m[2]) if m[2] else 1
                bag[name]=bag.get(name,0)+q
        if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or v<0 for v in bag.values()):raise EngineError('BAG_QUANTITY','Bag quantities must be finite and nonnegative')
        return {k:(int(v) if float(v).is_integer() else v) for k,v in bag.items() if v!=0},'known'
    if typ=='TAGS':
        if isinstance(raw,list):return copy.deepcopy(raw),'known'
        if isinstance(raw,str) and raw.lstrip().startswith(('[{','["')):
            try:parsed=json.loads(raw)
            except Exception as exc:raise EngineError('TAGS_JSON','Invalid structured tag list',error=str(exc))
            if not isinstance(parsed,list) or any(not isinstance(x,(str,dict)) for x in parsed):raise EngineError('TAGS_TYPE','Tag list must contain names or tag objects')
            return [copy.deepcopy(x) if isinstance(x,dict) else {'name':x} for x in parsed],'known'
        tags=[]
        for part in re.split(r'[,，;；]',str(raw).strip('[] ')):
            if not part or part in {'正常','无'}:continue
            m=re.fullmatch(r'(.+?)\((\d+(?:\.\d+)?)([dhmt])\)',part.strip(),re.I)
            tags.append({'name':m[1].strip(),'duration':float(m[2]),'unit':m[3].lower()} if m else {'name':part.strip()})
        return tags,'known'
    if typ in {'JSON','ARRAY','OBJECT','REF_LIST','TEXT_LIST'} or (typ=='CHILD_REF' and (isinstance(raw,(dict,list)) or isinstance(raw,str) and raw.lstrip().startswith(('[','{')))):
        try:v=json.loads(raw) if isinstance(raw,str) else raw
        except Exception as exc:raise EngineError('JSON_SYNTAX','Invalid structured value',field=spec['key'],error=str(exc))
        if typ in {'ARRAY','REF_LIST','TEXT_LIST'} and not isinstance(v,list):raise EngineError('ARRAY_TYPE','List required',field=spec['key'])
        if typ=='OBJECT' and not isinstance(v,dict):raise EngineError('OBJECT_TYPE','Object required',field=spec['key'])
        return v,'known'
    if not isinstance(raw,str):raise EngineError('TEXT_TYPE','Text/ID fields retain text values',field=spec['key'],value=raw)
    return raw,'known'


def encoded_value(value,state='known'):
    if state not in {'known','derived'}:return {'unset':None,'unknown':'?','cleared':'!','none':'∅','not_applicable':'—'}.get(state)
    if isinstance(value,(dict,list)):return json.dumps(value,ensure_ascii=False,separators=(',',':'))
    return value


class MatrixBook:
    def __init__(self,path,catalog=None):
        self.path=Path(path);self.catalog=copy.deepcopy(catalog or {'tables':[],'common_fields':[]})
        with zipfile.ZipFile(self.path) as z:self.parts={n:z.read(n) for n in z.namelist()}
        self.book=ET.fromstring(self.parts['xl/workbook.xml']);self.rels=ET.fromstring(self.parts['xl/_rels/workbook.xml.rels'])
        rels={x.get('Id'):x.get('Target') for x in self.rels}
        strings=[]
        if 'xl/sharedStrings.xml' in self.parts:
            strings=[''.join(x.itertext()) for x in ET.fromstring(self.parts['xl/sharedStrings.xml']).findall('s:si',NS)]
        self.sheets={};self.sheet_paths={};self.raw={};self.cells={};self.formulas={};self.locations={};self.frames=[];self.row_locations={}
        for s in self.book.findall('s:sheets/s:sheet',NS):
            target=rels[s.get('{'+REL+'}id')];p=target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/'+target)
            title=s.get('name');root=ET.fromstring(self.parts[p]);self.sheets[title]=root;self.sheet_paths[title]=p;self.raw[title]={};self.cells[title]={}
            for c in root.findall('s:sheetData/s:row/s:c',NS):
                ref=c.get('r');v=c.find('s:v',NS);inline=c.find('s:is',NS);f=c.find('s:f',NS);value=v.text if v is not None else None
                if c.get('t')=='s' and value is not None:value=strings[int(value)]
                elif inline is not None:value=''.join(inline.itertext())
                elif c.get('t')=='b':value=value=='1'
                elif value is not None and c.get('t') not in {'str','e'}:
                    try:value=int(value) if re.fullmatch(r'[+-]?\d+',value) else float(value);value=int(value) if isinstance(value,float) and value.is_integer() else value
                    except ValueError:pass
                self.raw[title][ref]=value;self.cells[title][ref]=c
                if f is not None:self.formulas[f'{title}!{ref}']='='+str(f.text or '')
        self.schema={t['id']:copy.deepcopy(t) for t in self.catalog.get('tables',[])}

    def read(self):
        tables={tid:{} for tid in self.schema};seen=set()
        for sheet,raw in self.raw.items():
            markers=sorted([(address(a)[1],v) for a,v in raw.items() if a.startswith('A') and re.fullmatch(r'A\d+',a) and isinstance(v,str) and v.startswith('@TABLE|')])
            for start,marker in markers:
                bits=marker.split('|');tid=bits[1];part=int(bits[2]) if len(bits)>2 else 1;hr=start+1
                if tid not in self.schema:self.schema[tid]={'id':tid,'label':tid,'fields':[],'sheet':sheet};tables[tid]={}
                fmap={f['key']:f for f in self.schema[tid]['fields']};headers={}
                for a,v in raw.items():
                    cc,rr=address(a)
                    if rr!=hr:continue
                    spec=parse_header(v)
                    if not spec:continue
                    combined=copy.deepcopy(fmap.get(spec['key'],{}));combined.update(spec);headers[cc]=combined
                    if spec['key'] not in fmap:self.schema[tid]['fields'].append(combined);fmap[spec['key']]=combined
                ids=[n for n,x in headers.items() if x['key']=='row_uuid']
                if len(ids)!=1:raise EngineError('HEADER_ID','One row_uuid header is required',sheet=sheet,row=hr,table=tid)
                idcol=ids[0];end=hr+1
                limit=max([address(a)[1] for a in raw] or [hr])+1
                while end<=limit:
                    v=raw.get(f'A{end}')
                    if isinstance(v,str) and (v.startswith('@END') or v.startswith('@TABLE|')):break
                    end+=1
                frame={'sheet':sheet,'table_id':tid,'part':part,'header_row':hr,'start':hr+1,'end':end,'headers':headers,'idcol':idcol};self.frames.append(frame)
                for rr in range(hr+1,end):
                    rid=raw.get(f'{col(idcol)}{rr}')
                    nonempty=any(raw.get(f'{col(cc)}{rr}') not in (None,'') or f'{sheet}!{col(cc)}{rr}' in self.formulas for cc in headers if cc!=idcol)
                    if rid in (None,''):
                        if nonempty:raise EngineError('MISSING_RECORD_ID','Fill stable record ID or use the add-record command',sheet=sheet,row=rr,table=tid)
                        continue
                    rid=str(rid);dup=(tid,part,rid)
                    if dup in seen:raise EngineError('DUPLICATE_ID','Duplicate record ID in the same field group',table=tid,part=part,record=rid)
                    seen.add(dup);self.row_locations[(tid,rid,part)]=(frame,rr)
                    rec=tables[tid].setdefault(rid,{'values':{'row_uuid':rid},'states':{'row_uuid':'known'},'formulas':{},'metadata':{}})
                    for cc,spec in headers.items():
                        key=spec['key'];ref=f'{col(cc)}{rr}';v=raw.get(ref);full=f'{sheet}!{ref}'
                        if key=='row_uuid':value,st=rid,'known'
                        elif full in self.formulas and spec.get('type')!='EXPR':value,st=None,'derived';rec['formulas'][key]=self.formulas[full]
                        else:value,st=decode_value(v,spec)
                        if isinstance(v,str) and spec.get('type') in {'NUMBER','INTEGER','DECIMAL','FLOAT','RATIO','INT'}:
                            gauge=re.fullmatch(r'([+-]?\d+(?:\.\d+)?)/([+-]?\d+(?:\.\d+)?)',v.strip())
                            if gauge:rec['metadata'].setdefault(key,{})['gauge_max']=float(gauge[2])
                        if key in rec['values'] and key!='row_uuid' and rec['states'].get(key)!='unset' and st!='unset' and rec['values'][key]!=value:raise EngineError('FIELD_COLLISION','One field has conflicting values across groups',table=tid,record=rid,field=key)
                        if st!='unset' or key not in rec['values']:rec['values'][key]=value;rec['states'][key]=st
                        self.locations[(tid,rid,key)]=(sheet,ref)
        for tid,rows in tables.items():
            for rid,rec in rows.items():
                for f in self.schema[tid]['fields']:
                    if f.get('alias_of') in {'common.row_uuid','row_uuid'}:rec['values'][f['key']]=rid;rec['states'][f['key']]='known'
        meta={}
        if '附录_运行快照' in self.raw:
            chunks=[(address(a)[1],v) for a,v in self.raw['附录_运行快照'].items() if a.startswith('B') and re.fullmatch(r'B\d+',a) and isinstance(v,str)]
            if chunks:
                try:meta=json.loads(''.join(x[1] for x in sorted(chunks)))
                except Exception as exc:raise EngineError('SNAPSHOT_INVALID','Stored runtime metadata is invalid',error=str(exc))
        return {'schema':self.schema,'tables':tables,'runtime':meta,'definition_meta':{k:copy.deepcopy(self.catalog.get(k,[])) for k in ['relations','derivations','common_fields']},'format':'tisya.matrix-state.v1'}

    def _put(self,sheet,ref,value,formula=None,cached=None):
        root=self.sheets[sheet];data=root.find('s:sheetData',NS)
        if data is None:data=ET.SubElement(root,'{'+MAIN+'}sheetData')
        cc,rr=address(ref);row=next((x for x in data if x.get('r')==str(rr)),None)
        if row is None:row=ET.SubElement(data,'{'+MAIN+'}row',{'r':str(rr)})
        cell=next((x for x in row if x.get('r')==ref),None)
        if cell is None:cell=ET.SubElement(row,'{'+MAIN+'}c',{'r':ref})
        style=cell.get('s');cell.clear();cell.set('r',ref)
        if style is not None:cell.set('s',style)
        def val(v):
            if v is None:return
            if isinstance(v,bool):cell.set('t','b');ET.SubElement(cell,'{'+MAIN+'}v').text='1' if v else '0'
            elif isinstance(v,(int,float)) and not isinstance(v,bool):ET.SubElement(cell,'{'+MAIN+'}v').text=str(v)
            elif formula:cell.set('t','str');ET.SubElement(cell,'{'+MAIN+'}v').text=str(v)
            else:
                cell.set('t','inlineStr');t=ET.SubElement(ET.SubElement(cell,'{'+MAIN+'}is'),'{'+MAIN+'}t');t.set('{http://www.w3.org/XML/1998/namespace}space','preserve');t.text=str(v)
        if formula:ET.SubElement(cell,'{'+MAIN+'}f').text=formula.lstrip('=');val(cached)
        else:val(value)
        self.raw[sheet][ref]=value;self.cells[sheet][ref]=cell

    def _new_sheet(self,name):
        if name in self.sheets:return
        sheets=self.book.find('s:sheets',NS);sid=max([int(x.get('sheetId')) for x in sheets] or [0])+1
        rid='rIdTisya'+str(sid);path=f'xl/worksheets/tisya{sid}.xml'
        ET.SubElement(sheets,'{'+MAIN+'}sheet',{'name':name,'sheetId':str(sid),'{'+REL+'}id':rid})
        ET.SubElement(self.rels,'{'+PKG+'}Relationship',{'Id':rid,'Type':REL+'/worksheet','Target':'worksheets/tisya'+str(sid)+'.xml'})
        content=ET.fromstring(self.parts['[Content_Types].xml']);ct='{http://schemas.openxmlformats.org/package/2006/content-types}Override'
        ET.SubElement(content,ct,{'PartName':'/'+path,'ContentType':'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'});self.parts['[Content_Types].xml']=ET.tostring(content,encoding='utf-8',xml_declaration=True)
        root=ET.Element('{'+MAIN+'}worksheet');ET.SubElement(root,'{'+MAIN+'}sheetData');self.sheets[name]=root;self.sheet_paths[name]=path;self.raw[name]={};self.cells[name]={}

    def write(self,state,destination):
        self.schema=state['schema']
        # The submitted matrices own current records. Clear removed rows and
        # omitted values in the source workbook before filling surviving data.
        # Keeping OOXML cell styles does not mean keeping stale business values.
        for frame in self.frames:
            sheet=frame['sheet'];tid=frame['table_id']
            for rr in range(frame['start'],frame['end']):
                rid=self.raw[sheet].get(f"{col(frame['idcol'])}{rr}")
                if rid in (None,''):continue
                record=state['tables'].get(tid,{}).get(str(rid))
                for cc,spec in frame['headers'].items():
                    if record is None or spec['key'] not in record['values']:
                        self._put(sheet,f'{col(cc)}{rr}',None)
        for tid,rows in state['tables'].items():
            if not rows:continue
            defs={f['key']:f for f in self.schema[tid]['fields']}
            for rid,rec in rows.items():
                for key,value in rec['values'].items():
                    if key not in defs:continue
                    spec=defs[key]
                    if spec.get('alias_of'):continue
                    loc=self.locations.get((tid,rid,key))
                    if loc is None:
                        frames=[x for x in self.frames if x['table_id']==tid and any(y['key']==key for y in x['headers'].values())]
                        frame=None;rr=None
                        for candidate in frames:
                            match=next((n for n in range(candidate['start'],candidate['end']) if self.raw[candidate['sheet']].get(f"{col(candidate['idcol'])}{n}")==rid),None)
                            if match is not None:frame=candidate;rr=match;break
                        if frame is None:
                            for candidate in frames:
                                empty=next((n for n in range(candidate['start'],candidate['end']) if self.raw[candidate['sheet']].get(f"{col(candidate['idcol'])}{n}") in (None,'')),None)
                                if empty is not None:frame=candidate;rr=empty;break
                        if frame is None or rr is None:
                            sheet=self.schema[tid].get('sheet','扩展对象')[:31];self._new_sheet(sheet)
                            start=max([address(a)[1] for a in self.raw[sheet]] or [0])+3
                            existing=[x for x in self.frames if x['table_id']==tid]
                            represented={f['key'] for x in existing for f in x['headers'].values()}
                            new_field=key not in represented
                            if frames:
                                fields=list(frames[0]['headers'].values());part=frames[0]['part']
                            else:
                                fields=[defs.get('row_uuid',{'key':'row_uuid','label':'记录ID','type':'ID'})]+[f for f in defs.values() if f['key']!='row_uuid' and not f.get('alias_of') and (not new_field or f['key'] not in represented)]
                                part=max([x['part'] for x in existing] or [0])+1 if new_field else 1
                            self._put(sheet,f'A{start}',f'@TABLE|{tid}|{part}')
                            headers={i+1:f for i,f in enumerate(fields)}
                            for cc,f in headers.items():self._put(sheet,f'{col(cc)}{start+1}',f"{f.get('label',f['key'])}\n{f['key']}|{f.get('type','TEXT')}")
                            self._put(sheet,f'A{start+3}','@END')
                            frame={'sheet':sheet,'table_id':tid,'part':part,'header_row':start+1,'start':start+2,'end':start+3,'headers':headers,'idcol':1};self.frames.append(frame);rr=start+2
                        sheet=frame['sheet'];idref=f"{col(frame['idcol'])}{rr}";self._put(sheet,idref,rid)
                        cc=next(cc for cc,f in frame['headers'].items() if f['key']==key);loc=(sheet,f'{col(cc)}{rr}');self.locations[(tid,rid,key)]=loc
                        # One blank row can host multiple fields of this record on subsequent iterations.
                    sheet,ref=loc;formula=rec.get('formulas',{}).get(key);encoded=encoded_value(value,rec['states'].get(key,'known'))
                    gauge=rec.get('metadata',{}).get(key,{}).get('gauge_max')
                    if gauge is not None and isinstance(value,(int,float)) and not formula:encoded=f'{value:g}/{gauge:g}'
                    self._put(sheet,ref,encoded,formula=formula,cached=value)
        # Runtime metadata excludes current table values: the matrices remain their only editable owner.
        runtime=copy.deepcopy(state.get('runtime',{}));sheet='附录_运行快照';self._new_sheet(sheet)
        data=self.sheets[sheet].find('s:sheetData',NS);data.clear();self.raw[sheet]={};self.cells[sheet]={}
        self._put(sheet,'A1','执行记录、原文与世界时钟；由引擎维护')
        text=json.dumps(runtime,ensure_ascii=False,separators=(',',':'))
        for i in range(0,len(text),24000):self._put(sheet,f'A{i//24000+3}',i//24000+1);self._put(sheet,f'B{i//24000+3}',text[i:i+24000])
        for sheet,root in self.sheets.items():
            data=root.find('s:sheetData',NS)
            if data is not None:
                data[:]=sorted(data,key=lambda x:int(x.get('r','0')))
                for row in data:row[:]=sorted(row,key=lambda x:address(x.get('r'))[0])
            dim=root.find('s:dimension',NS)
            if dim is not None and self.raw[sheet]:
                coords=[address(a) for a in self.raw[sheet]];dim.set('ref',f"A1:{col(max(x[0] for x in coords))}{max(x[1] for x in coords)}")
            self.parts[self.sheet_paths[sheet]]=ET.tostring(root,encoding='utf-8',xml_declaration=True).replace(b'\r',b'&#13;')
        self.parts['xl/workbook.xml']=ET.tostring(self.book,encoding='utf-8',xml_declaration=True);self.parts['xl/_rels/workbook.xml.rels']=ET.tostring(self.rels,encoding='utf-8',xml_declaration=True)
        destination=Path(destination);destination.parent.mkdir(parents=True,exist_ok=True);temp=destination.with_suffix(destination.suffix+'.pending')
        with zipfile.ZipFile(temp,'w',zipfile.ZIP_DEFLATED) as z:
            for name,data in self.parts.items():z.writestr(name,data)
        with zipfile.ZipFile(temp) as z:
            if z.testzip() is not None:raise EngineError('XLSX_WRITE','XLSX CRC verification failed')
        temp.replace(destination);return destination
