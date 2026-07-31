// 错别字找茬关卡：文本中藏有常见错别字，玩家找出并改正
// 语料为精选"高频易错字"句子，均为现实中常见的真实误写
import { estimateDifficulty, categoryForDifficulty } from '../difficulty.js';
import { pick, sample, randomUUID } from '../util.js';

const TITLES = ['火眼金睛找错字', '错别字在哪里？', '一字之差'];

// 每条：text 含且仅含一次 wrong 字；correct 为规范写法（对应正确词形见 right 字段）
export const TYPO_CORPUS = [
  { text: '他决定再接再励，争取下次考出好成绩。', wrong: '励', correct: '厉', right: '再接再厉' },
  { text: '听到开饭，弟弟迫不急待地冲向餐桌。', wrong: '急', correct: '及', right: '迫不及待' },
  { text: '大街上车辆穿流不息，热闹非凡。', wrong: '穿', correct: '川', right: '川流不息' },
  { text: '这局棋我输得心服口服，甘败下风。', wrong: '败', correct: '拜', right: '甘拜下风' },
  { text: '敌人被逼得走头无路，只好投降。', wrong: '头', correct: '投', right: '走投无路' },
  { text: '他一如继往地坚持晨跑锻炼身体。', wrong: '继', correct: '既', right: '一如既往' },
  { text: '杭州西湖名符其实，风景如画。', wrong: '符', correct: '副', right: '名副其实' },
  { text: '老先生已经病入膏盲，医生也无能为力。', wrong: '盲', correct: '肓', right: '病入膏肓' },
  { text: '这个小山村宛如世外桃园，宁静美好。', wrong: '园', correct: '源', right: '世外桃源' },
  { text: '宴会上宾主谈笑风声，气氛融洽。', wrong: '声', correct: '生', right: '谈笑风生' },
  { text: '为了大局，他只能委屈求全。', wrong: '屈', correct: '曲', right: '委曲求全' },
  { text: '学习贵在融汇贯通，不能死记硬背。', wrong: '汇', correct: '会', right: '融会贯通' },
  { text: '理论与实践相辅相承，缺一不可。', wrong: '承', correct: '成', right: '相辅相成' },
  { text: '工作要按步就班地推进，不可急躁。', wrong: '步', correct: '部', right: '按部就班' },
  { text: '他不但不收敛，反而变本加利。', wrong: '利', correct: '厉', right: '变本加厉' },
  { text: '面对难题，大家一愁莫展。', wrong: '愁', correct: '筹', right: '一筹莫展' },
  { text: '这套服装设计别出心栽，令人耳目一新。', wrong: '栽', correct: '裁', right: '别出心裁' },
  { text: '这首诗脍灸人口，流传千年。', wrong: '灸', correct: '炙', right: '脍炙人口' },
  { text: '旅行时他给朋友寄了一张名信片。', wrong: '名', correct: '明', right: '明信片' },
  { text: '指挥中心重新布署了防汛工作。', wrong: '布', correct: '部', right: '部署' },
  { text: '有话就直接了当地说出来吧。', wrong: '接', correct: '截', right: '直截了当' },
  { text: '他在车站等侯了整整两个小时。', wrong: '侯', correct: '候', right: '等候' },
  { text: '散会后请大家立既回到岗位。', wrong: '既', correct: '即', right: '立即' },
  { text: '商场打折，顾客蜂涌而至。', wrong: '涌', correct: '拥', right: '蜂拥而至' },
  { text: '两人表面亲密，实则貌和神离。', wrong: '和', correct: '合', right: '貌合神离' },
  { text: '古人悬梁刺骨的精神令人敬佩。', wrong: '骨', correct: '股', right: '悬梁刺股' },
  { text: '学习要脚踏实地，不能好高鹜远。', wrong: '鹜', correct: '骛', right: '好高骛远' },
  { text: '老师为学生们沤心沥血，令人感动。', wrong: '沤', correct: '呕', right: '呕心沥血' },
  { text: '他成绩优异，在班里出类拔粹。', wrong: '粹', correct: '萃', right: '出类拔萃' },
  { text: '将军下令破斧沉舟，与敌决一死战。', wrong: '斧', correct: '釜', right: '破釜沉舟' },
  { text: '他自知水平不够，只是烂竽充数罢了。', wrong: '烂', correct: '滥', right: '滥竽充数' },
  { text: '那家公司因造假而声名狼籍。', wrong: '籍', correct: '藉', right: '声名狼藉' },
  { text: '宫殿装饰得金壁辉煌，气势恢宏。', wrong: '壁', correct: '碧', right: '金碧辉煌' },
  { text: '两国的贸易额与日剧增。', wrong: '剧', correct: '俱', right: '与日俱增' },
  { text: '教室粉刷后换然一新。', wrong: '换', correct: '焕', right: '焕然一新' },
  { text: '他干得汗流夹背，衣服都湿透了。', wrong: '夹', correct: '浃', right: '汗流浃背' },
  { text: '万事具备，只欠东风。', wrong: '具', correct: '俱', right: '万事俱备' },
  { text: '他从小骄生惯养，吃不了苦。', wrong: '骄', correct: '娇', right: '娇生惯养' },
];

function toTypo(item, offset = 0) {
  return { pos: item.text.indexOf(item.wrong) + offset, wrong: item.wrong, correct: item.correct };
}

export function generateTypoFind(rng = Math.random) {
  // 约四成概率拼接两句，形成双错字的高难度关卡
  const double = rng() < 0.4;
  const items = double ? sample(TYPO_CORPUS, 2, rng) : [pick(TYPO_CORPUS, rng)];
  let text = '';
  const typos = [];
  for (const item of items) {
    typos.push(toTypo(item, text.length));
    text += item.text;
  }
  const difficulty = estimateDifficulty('typoFind', {
    textLength: text.length,
    typoCount: typos.length,
  });
  return {
    id: randomUUID(),
    type: 'typoFind',
    difficulty,
    title: pick(TITLES, rng),
    data: { text, typos },
    meta: {
      category: categoryForDifficulty(difficulty),
      tags: ['汉字', '错别字'],
    },
  };
}
