// The saved prompt is the only narrative source; controls edit its exact spans.
export function directiveFields(source){
  const matches=[...source.matchAll(/^@([A-Z][A-Z0-9_.]*)\s*:=\s*/gm)];
  return matches.map((m,i)=>{
    const start=m.index+m[0].length;
    let end=matches[i+1]?.index??source.length;
    if(i===matches.length-1){const close=source.slice(start).search(/\n<\/[\w-]+>\s*$/);if(close>=0)end=start+close;}
    while(end>start&&/[\r\n]/.test(source[end-1]))end--;
    return {key:m[1],start,end,value:source.slice(start,end)};
  });
}
export function editDirective(source,key,value){
  const field=directiveFields(source).find(f=>f.key===key);
  if(!field)throw Error('叙事配置中不存在此项：'+key);
  return source.slice(0,field.start)+value+source.slice(field.end);
}
export const directiveLabels={
  'AVATAR.BIND':'主控身份与场外身份','POV.PERSON':'叙事人称','POV.LENS':'焦点与镜头',
  'AUTH.ACT':'言语与行动代演','AUTH.MIND':'内心代演边界','STOP.GATE':'重大选择与停笔点',
  'TASK.MODE':'互动方式','EPISTEMIC.FOG':'限知与秘密','SIDEPLOT.CUT':'旁线切镜','INPUT.TRACK':'场内与场外输入',
  'USER.IDIOLECT':'主控口癖','LANG.GATE':'语言与译注','GRAMMAR.DENSITY':'句法密度','GAZE.LENS':'观察视角',
  'GAZE.DIR':'关注方向','ART.POS':'文风基调','ART.SCULPT':'描写技法','DIALOGUE.RATIO':'对白比例',
  'PROSE.DISCIPLINE':'行文纪律','INTERNAL_LOGIT_CALIBRATION':'禁用表达与用词检查',
  'TISYA_THERMAL_WORDING':'热度用词','CLIMAX.INK_BASE':'关键段落篇幅','PLOT.TONE':'故事基调',
  'PLOT.PACE':'情节速度','PLOT.INTENSITY':'冲突强度','WORLD.AUTONOMY':'世界自主性','WORLD.CLOCK':'世界时间',
  'PLOT.RATING':'题材尺度','INK.GRANULARITY':'描写颗粒度','INK.FOCUS_CLIMAX':'高潮着墨',
  'INK.FOCUS_EROTIC':'亲密情节着墨','INK.FOCUS_SPARRING':'交锋着墨','CHAR.AUTONOMY':'角色自主性',
  'CHAR.DEPTH_AND_NUANCE':'角色深度与矛盾','CHAR.VILLAINY':'反派塑造','CHAR.SUBTEXT_AND_COERCION':'潜台词与压力',
  'CHAR.INTELLECT':'智力与推理','CHAR.ENSEMBLE_AND_HABIT':'群像与生活习惯','PREF.SCOPE_AND_FILTER':'全局与单角色偏好'
};
export const settingLabels={temperature:'温度',frequency_penalty:'频率惩罚',presence_penalty:'存在惩罚',top_p:'Top P',top_k:'Top K',top_a:'Top A',min_p:'Min P',repetition_penalty:'重复惩罚',max_context_unlocked:'解锁上下文长度',tool_reasoning_mode:'工具推理模式',openai_max_context:'上下文上限',openai_max_tokens:'最大输出长度',names_behavior:'姓名处理',send_if_empty:'空输入文本',impersonation_prompt:'代写用户提示词',new_chat_prompt:'新会话提示词',new_group_chat_prompt:'新群聊提示词',new_example_chat_prompt:'示例会话提示词',continue_nudge_prompt:'续写提示词',bias_preset_selected:'词元偏置预设',wi_format:'世界书格式',scenario_format:'场景格式',personality_format:'性格格式',group_nudge_prompt:'群聊角色提示词',stream_openai:'流式输出',assistant_prefill:'助手预填',assistant_impersonation:'代写预填',use_sysprompt:'使用系统提示词',squash_system_messages:'合并系统消息',media_inlining:'内联媒体',inline_image_quality:'图片质量',continue_prefill:'续写预填',continue_postfix:'续写后缀',function_calling:'函数调用',tool_call_recurse_limit:'工具递归上限',show_thoughts:'显示思考',reasoning_effort:'推理强度',verbosity:'详细程度',enable_web_search:'联网搜索',seed:'随机种子',n:'候选数',request_images:'请求图片',request_image_aspect_ratio:'图片比例',request_image_resolution:'图片分辨率',strip_old_tool_calls:'移除旧工具调用',claude_fast_mode:'Claude 快速模式'};

export function presetFieldValue(original,text){
  if(typeof original==='number'){const n=Number(text);if(text.trim()===''||!Number.isFinite(n))throw Error('数值配置需要有限数字。');return n;}
  if(typeof original==='boolean')return Boolean(text);
  return text;
}
