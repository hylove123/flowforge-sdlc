/**
 * 开放数据域（好友排行）
 * 主域通过 postMessage({type:'showFriendRank', width, height}) 触发绘制，
 * 子域用 wx.getFriendCloudStorage 读取好友托管数据（key: 'score'），
 * 在共享 Canvas 上绘制列表，由主域 drawImage 贴到排行榜场景。
 *
 * 注意：开放数据域是隔离环境，不能与主域共享代码，故样式常量在此重复定义。
 */

const sharedCanvas = wx.getSharedCanvas();
const ctx = sharedCanvas.getContext('2d');

// 与主域保持一致的水墨风配色
const COLOR = {
  ink: '#2B2B2B',
  gray: '#9A948A',
  faint: '#E7E2D8',
  accent: '#C53D43',
  white: '#FFFFFF',
};

const ROW_HEIGHT = 52;
const AVATAR_SIZE = 32;

let viewWidth = sharedCanvas.width || 300;
let viewHeight = sharedCanvas.height || 400;

wx.onMessage((msg) => {
  if (!msg || msg.type !== 'showFriendRank') return;
  if (msg.width && msg.height) {
    viewWidth = msg.width;
    viewHeight = msg.height;
    sharedCanvas.width = viewWidth;
    sharedCanvas.height = viewHeight;
  }
  fetchAndRender();
});

function fetchAndRender() {
  renderHint('好友榜加载中…');
  wx.getFriendCloudStorage({
    keyList: ['score'],
    success(res) {
      const list = (res.data || [])
        .map((user) => {
          const kv = (user.KVDataList || []).find((item) => item.key === 'score');
          return {
            nickname: user.nickname || '书生',
            avatarUrl: user.avatarUrl || '',
            score: kv ? Number(kv.value) || 0 : 0,
          };
        })
        .sort((a, b) => b.score - a.score);
      renderList(list);
    },
    fail(err) {
      console.warn('[open-data] getFriendCloudStorage failed:', err);
      renderHint('好友数据获取失败');
    },
  });
}

function clear() {
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.clearRect(0, 0, viewWidth, viewHeight);
}

function renderHint(text) {
  clear();
  ctx.font = '14px sans-serif';
  ctx.fillStyle = COLOR.gray;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, viewWidth / 2, 80);
}

function renderList(list) {
  clear();
  if (!list.length) {
    renderHint('还没有好友上榜，快去邀请吧');
    return;
  }

  const maxRows = Math.max(1, Math.floor(viewHeight / ROW_HEIGHT));
  list.slice(0, maxRows).forEach((item, i) => {
    const top = i * ROW_HEIGHT;
    const centerY = top + ROW_HEIGHT / 2;
    const isTop3 = i < 3;

    // 名次
    ctx.font = `${isTop3 ? 'bold ' : ''}16px sans-serif`;
    ctx.fillStyle = isTop3 ? COLOR.accent : COLOR.gray;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), 20, centerY);

    // 头像（圆形裁剪，加载完成后异步补绘）
    const avatarX = 42;
    const avatarY = centerY - AVATAR_SIZE / 2;
    drawAvatar(item.avatarUrl, avatarX, avatarY);

    // 昵称
    ctx.font = '15px sans-serif';
    ctx.fillStyle = COLOR.ink;
    ctx.textAlign = 'left';
    ctx.fillText(clipText(item.nickname, 8), avatarX + AVATAR_SIZE + 12, centerY);

    // 分数
    ctx.font = 'bold 15px sans-serif';
    ctx.fillStyle = COLOR.ink;
    ctx.textAlign = 'right';
    ctx.fillText(String(item.score), viewWidth - 12, centerY);

    // 分割线
    ctx.strokeStyle = COLOR.faint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, top + ROW_HEIGHT);
    ctx.lineTo(viewWidth, top + ROW_HEIGHT);
    ctx.stroke();
  });
}

function drawAvatar(url, x, y) {
  // 占位圆
  ctx.fillStyle = COLOR.faint;
  ctx.beginPath();
  ctx.arc(x + AVATAR_SIZE / 2, y + AVATAR_SIZE / 2, AVATAR_SIZE / 2, 0, Math.PI * 2);
  ctx.fill();

  if (!url) return;
  const img = wx.createImage();
  img.onload = () => {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + AVATAR_SIZE / 2, y + AVATAR_SIZE / 2, AVATAR_SIZE / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, x, y, AVATAR_SIZE, AVATAR_SIZE);
    ctx.restore();
  };
  img.src = url;
}

function clipText(text, maxChars) {
  const chars = Array.from(String(text));
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : text;
}
