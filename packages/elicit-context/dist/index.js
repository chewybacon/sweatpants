// src/encode.ts
function encodeElicitContext(message, context, schema) {
  const schemaWithContext = {
    ...schema,
    "x-elicit-context": context
  };
  const contextJson = JSON.stringify(context);
  const messageWithContext = `${message}

--x-elicit-context: application/json
${contextJson}`;
  return {
    message: messageWithContext,
    schema: schemaWithContext
  };
}

// src/decode.ts
function extractContextFromMessage(message) {
  const boundaryMarker = "\n--x-elicit-context: application/json\n";
  const boundaryIndex = message.indexOf(boundaryMarker);
  if (boundaryIndex === -1) {
    return null;
  }
  try {
    const contextJson = message.slice(boundaryIndex + boundaryMarker.length);
    return JSON.parse(contextJson);
  } catch {
    return null;
  }
}
function stripMessageContext(message) {
  const boundaryIndex = message.indexOf("\n--x-elicit-context:");
  return boundaryIndex === -1 ? message : message.slice(0, boundaryIndex).trim();
}
function decodeElicitContext(message, schema) {
  let context = schema["x-elicit-context"];
  if (context === void 0) {
    context = extractContextFromMessage(message);
  }
  if (context === null || context === void 0) {
    context = {};
  }
  const cleanMessage = stripMessageContext(message);
  return {
    message: cleanMessage,
    context
  };
}

export { decodeElicitContext, encodeElicitContext, stripMessageContext };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map