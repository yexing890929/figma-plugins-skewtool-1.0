const MAX_ANGLE = 60;
const EPSILON = 0.0001;

figma.showUI(__html__, { width: 240, height: 386, title: "Skew Tool" });

const initialTransforms = new Map();
const previewOrigins = new Map();
const history = [];
const ANCHORS = {
  "top-left": { x: 0, y: 0 },
  "top-center": { x: 0.5, y: 0 },
  "top-right": { x: 1, y: 0 },
  "center-left": { x: 0, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  "center-right": { x: 1, y: 0.5 },
  "bottom-left": { x: 0, y: 1 },
  "bottom-center": { x: 0.5, y: 1 },
  "bottom-right": { x: 1, y: 1 },
};

function isSupported(node) {
  return "relativeTransform" in node && "width" in node && "height" in node;
}

function hasOnlyRotation(transform) {
  const xAxisLength = Math.hypot(transform[0][0], transform[1][0]);
  const yAxisLength = Math.hypot(transform[0][1], transform[1][1]);
  const dotProduct = transform[0][0] * transform[0][1] + transform[1][0] * transform[1][1];

  return (
    Math.abs(xAxisLength - 1) < EPSILON &&
    Math.abs(yAxisLength - 1) < EPSILON &&
    Math.abs(dotProduct) < EPSILON
  );
}

function isAutoLayoutChild(node) {
  return node.parent && "layoutMode" in node.parent && node.parent.layoutMode !== "NONE";
}

function cloneTransform(transform) {
  return transform.map((row) => [...row]);
}

function createSkewTransform(horizontalAngle, verticalAngle) {
  const horizontalRadians = (horizontalAngle * Math.PI) / 180;
  const verticalRadians = (verticalAngle * Math.PI) / 180;

  return [
    [Math.cos(verticalRadians), Math.sin(horizontalRadians), 0],
    [Math.sin(verticalRadians), Math.cos(horizontalRadians), 0],
  ];
}

function transformAroundAnchor(node, transform, horizontalAngle, verticalAngle, anchor) {
  const localTransform = createSkewTransform(horizontalAngle, verticalAngle);
  const anchorPoint = ANCHORS[anchor];
  if (!anchorPoint) {
    throw new Error("请选择有效的斜切锚点。");
  }

  const anchorX = node.width * anchorPoint.x;
  const anchorY = node.height * anchorPoint.y;
  const localOffsetX =
    anchorX - localTransform[0][0] * anchorX - localTransform[0][1] * anchorY;
  const localOffsetY =
    anchorY - localTransform[1][0] * anchorX - localTransform[1][1] * anchorY;

  const a = transform[0][0];
  const b = transform[0][1];
  const c = transform[1][0];
  const d = transform[1][1];
  const tx = transform[0][2];
  const ty = transform[1][2];

  return [
    [
      a * localTransform[0][0] + b * localTransform[1][0],
      a * localTransform[0][1] + b * localTransform[1][1],
      tx + a * localOffsetX + b * localOffsetY,
    ],
    [
      c * localTransform[0][0] + d * localTransform[1][0],
      c * localTransform[0][1] + d * localTransform[1][1],
      ty + c * localOffsetX + d * localOffsetY,
    ],
  ];
}

function getEligibleSelection() {
  const selected = figma.currentPage.selection;

  if (selected.length === 0) {
    throw new Error("请先选中一个图层。");
  }

  const unsupported = selected.find((node) => !isSupported(node));
  if (unsupported) {
    throw new Error(`暂不支持 ${unsupported.type} 图层。`);
  }

  const autoLayoutChild = selected.find(isAutoLayoutChild);
  if (autoLayoutChild) {
    throw new Error("暂不支持 Auto Layout 容器中的直接子项。");
  }

  const alreadySkewed = selected.find(
    (node) => !initialTransforms.has(node.id) && !hasOnlyRotation(node.relativeTransform),
  );
  if (alreadySkewed) {
    throw new Error("暂不支持打开插件前已斜切的图层。");
  }

  return selected;
}

function postSuccess(message) {
  figma.ui.postMessage({ type: "success", message });
}

function postError(error) {
  figma.ui.postMessage({ type: "error", message: error.message });
}

function ensureInitialTransforms(nodes) {
  nodes.forEach((node) => {
    if (!initialTransforms.has(node.id)) {
      initialTransforms.set(node.id, { node, transform: cloneTransform(node.relativeTransform) });
    }
  });
}

function setSkew(nodes, horizontalAngle, verticalAngle, anchor) {
  nodes.forEach((node) => {
    const initialTransform = initialTransforms.get(node.id).transform;
    node.relativeTransform = transformAroundAnchor(node, initialTransform, horizontalAngle, verticalAngle, anchor);
  });
}

function previewSkew(horizontalAngle, verticalAngle, anchor) {
  const nodes = getEligibleSelection();
  ensureInitialTransforms(nodes);
  nodes.forEach((node) => {
    if (!previewOrigins.has(node.id)) {
      previewOrigins.set(node.id, { node, transform: cloneTransform(node.relativeTransform) });
    }
  });
  setSkew(nodes, horizontalAngle, verticalAngle, anchor);
}

function applySkew(horizontalAngle, verticalAngle, anchor) {
  const nodes = getEligibleSelection();
  ensureInitialTransforms(nodes);
  const previousTransforms = nodes.map((node) => {
    const previewOrigin = previewOrigins.get(node.id);
    return previewOrigin || { node, transform: cloneTransform(node.relativeTransform) };
  });

  setSkew(nodes, horizontalAngle, verticalAngle, anchor);

  history.push(previousTransforms);
  nodes.forEach((node) => previewOrigins.delete(node.id));
  figma.commitUndo();
  figma.notify(`已对 ${nodes.length} 个图层应用斜切。`);
  postSuccess("已应用斜切");
}

function cancelPreview() {
  previewOrigins.forEach(({ node, transform }) => {
    if (!node.removed) node.relativeTransform = transform;
  });
  previewOrigins.clear();
}

function undoLastApply() {
  if (previewOrigins.size > 0) {
    cancelPreview();
    postSuccess("已取消当前预览");
    return;
  }

  const previousTransforms = history.pop();
  if (!previousTransforms) {
    throw new Error("没有可撤销的插件操作。");
  }

  previousTransforms.forEach(({ node, transform }) => {
    if (!node.removed) node.relativeTransform = transform;
  });
  figma.commitUndo();
  postSuccess("已撤销上一步斜切");
}

function resetSession() {
  if (initialTransforms.size === 0) {
    postSuccess("参数已重置");
    return;
  }

  let restoredCount = 0;
  initialTransforms.forEach(({ node, transform }) => {
    if (!node.removed) {
      node.relativeTransform = transform;
      restoredCount += 1;
    }
  });
  initialTransforms.clear();
  previewOrigins.clear();
  history.length = 0;
  figma.commitUndo();
  postSuccess(`已重置 ${restoredCount} 个图层`);
}

figma.ui.onmessage = (message) => {
  try {
    if (message.type === "preview-skew" || message.type === "apply-skew") {
      const horizontalAngle = Number(message.horizontalAngle);
      const verticalAngle = Number(message.verticalAngle);
      const anchor = message.anchor;

      if (
        !Number.isFinite(horizontalAngle) ||
        !Number.isFinite(verticalAngle) ||
        Math.abs(horizontalAngle) > MAX_ANGLE ||
        Math.abs(verticalAngle) > MAX_ANGLE
      ) {
        throw new Error(`请输入 ${-MAX_ANGLE}° 到 ${MAX_ANGLE}° 之间的数值。`);
      }

      if (message.type === "preview-skew") previewSkew(horizontalAngle, verticalAngle, anchor);
      if (message.type === "apply-skew") applySkew(horizontalAngle, verticalAngle, anchor);
    }
    if (message.type === "undo") undoLastApply();
    if (message.type === "reset") resetSession();
  } catch (error) {
    postError(error);
  }
};

figma.on("selectionchange", () => {
  if (previewOrigins.size > 0) cancelPreview();
  figma.ui.postMessage({ type: "clear-status" });
});
