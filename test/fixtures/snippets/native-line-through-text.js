// tldraw's own `line` shape, which is not an arrow at all, struck through a
// free text caption. Neither arrow rule has ever looked at one.
helpers.text('caption', 'attention is all you need', { x: 100, y: 100, size: 'm' })
editor.createShape({
  id: tldraw.createShapeId('rule'),
  type: 'line',
  x: 60,
  y: 115,
  props: {
    points: {
      a1: { id: 'a1', index: 'a1', x: 0, y: 0 },
      a2: { id: 'a2', index: 'a2', x: 360, y: 0 },
    },
  },
})
return helpers.getLints()
