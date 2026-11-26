import React, { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';

// 手写签名画板：原生 canvas + pointer 事件（兼容鼠标/触摸）。
// 用法：<SignaturePad ref={padRef} />，padRef.current.toBlob(cb) 导出 PNG。
const SignaturePad = forwardRef(function SignaturePad({ height = 160 }, ref) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 320;
    canvas.width = cssW * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1a1a1a';
    // 白底
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cssW, height);
  }, [height]);

  const pos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const p = e.touches && e.touches.length ? e.touches[0] : e;
    return { x: p.clientX - rect.left, y: p.clientY - rect.top };
  };

  const start = (e) => {
    e.preventDefault();
    drawing.current = true;
    hasInk.current = true;
    const ctx = canvasRef.current.getContext('2d');
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const move = (e) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const end = () => {
    drawing.current = false;
  };

  useImperativeHandle(ref, () => ({
    clear() {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0); // 复位 dpr 缩放，回到原始像素坐标
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height); // 用原始像素尺寸清全屏
      ctx.restore();
      hasInk.current = false;
    },
    isEmpty() {
      return !hasInk.current;
    },
    toBlob(cb) {
      canvasRef.current.toBlob(cb, 'image/png');
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      className="sig-pad"
      style={{ width: '100%', height, touchAction: 'none', display: 'block' }}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerLeave={end}
      onPointerCancel={end}
    />
  );
});

export default SignaturePad;
