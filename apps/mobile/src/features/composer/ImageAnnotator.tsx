import { useRef, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, StyleSheet, View } from 'react-native'

import { colors, radius } from '@/theme/tokens'
import { Text } from '@/ui/Text'
import { Web } from '@/ui/WebViewCompat'

const PAGE = (src: string, color: string) => `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body { margin: 0; height: 100%; background: #111; color: #ddd; font-family: sans-serif; overflow: hidden; }
  #wrap { position: relative; width: 100%; height: calc(100% - 52px); display: flex; align-items: center; justify-content: center; }
  canvas { max-width: 100%; max-height: 100%; touch-action: none; }
  nav { height: 52px; display: flex; align-items: center; justify-content: space-around; background: #1a1a1a; }
  button { background: #2a2a2a; color: #ddd; border: 0; border-radius: 8px; padding: 8px 14px; font-size: 14px; }
</style>
</head>
<body>
  <div id="wrap"><canvas id="c"></canvas></div>
  <nav>
    <button id="undo">Undo</button>
    <button id="clear">Clear</button>
    <button id="save">Save markup</button>
  </nav>
  <script>
    const color = ${JSON.stringify(color)};
    const src = ${JSON.stringify(src)};
    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const strokes = [];
    let current = null;
    function fit() {
      const maxW = wrap.clientWidth, maxH = wrap.clientHeight;
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      draw();
    }
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, canvas.width / 180);
      for (const s of strokes) {
        if (s.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(s[0].x, s[0].y);
        for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].y);
        ctx.stroke();
      }
    }
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    }
    canvas.addEventListener('pointerdown', (e) => { current = [pos(e)]; strokes.push(current); e.preventDefault(); });
    canvas.addEventListener('pointermove', (e) => { if (!current) return; current.push(pos(e)); draw(); e.preventDefault(); });
    window.addEventListener('pointerup', () => { current = null; });
    document.getElementById('undo').onclick = () => { strokes.pop(); draw(); };
    document.getElementById('clear').onclick = () => { strokes.length = 0; draw(); };
    document.getElementById('save').onclick = () => {
      const data = canvas.toDataURL('image/png').split(',')[1] || '';
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'save', data }));
    };
    img.onload = fit;
    img.onerror = () => {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: 'Could not load the image.' }));
    };
    window.addEventListener('resize', () => img.width && fit());
    img.src = src;
  </script>
</body>
</html>`

/**
 * Draw on an attached image, then save a new PNG (no extra native libraries).
 * Uses a small canvas in a WebView so the markup can be exported as pixels.
 */
export function ImageAnnotator({
  visible,
  uri,
  onClose,
  onSave,
}: {
  visible: boolean
  uri: string
  onClose(): void
  onSave(dataBase64: string): Promise<void> | void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const saving = useRef(false)

  const onMessage = async (event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as
        | { type: 'save'; data: string }
        | { type: 'error'; message: string }
      if (msg.type === 'error') {
        setError(msg.message)
        return
      }
      if (saving.current) return
      saving.current = true
      setBusy(true)
      setError(undefined)
      await onSave(msg.data)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.page}>
        <View style={styles.head}>
          <Text size={16} weight="semibold" style={{ flex: 1 }}>
            Mark up image
          </Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
            <Text size={14} color={colors.textSecondary}>
              Close
            </Text>
          </Pressable>
        </View>
        <Web
          originWhitelist={['*']}
          source={{ html: PAGE(uri, colors.accent) }}
          onMessage={onMessage}
          style={{ flex: 1, backgroundColor: colors.code }}
          javaScriptEnabled
          mixedContentMode="always"
        />
        {busy ? (
          <View style={styles.busy}>
            <ActivityIndicator color={colors.muted} />
          </View>
        ) : null}
        {error ? (
          <Text size={12} color={colors.danger} style={{ padding: 12 }}>
            {error}
          </Text>
        ) : null}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.panel, paddingTop: 48 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 12,
  },
  busy: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.overlay,
  },
  close: { borderRadius: radius.control },
})
