import { i as MethodOptions_IdempotencyLevel } from "./file-C7ic42ti.js";
import { A as createContextValues, B as Code, C as headerTimeout, I as appendHeaders, N as createEnvelopeReadableStream, P as encodeEnvelope, S as headerGrpcStatus, T as trailerParse, V as fromJson, _ as contentTypeProto, a as validateResponse$1, b as headerContentType, d as errorFromJson, f as createClientMethodSerializers, g as contentTypeJson, h as findTrailerError, i as transformConnectPostToGetRequest, l as trailerDemux, m as createMethodUrl, n as runStreamingCall, o as requestHeader$1, p as getJsonOptions, r as runUnaryCall, u as endStreamFromJson, v as headerXGrpcWeb, w as headerUserAgent, y as headerXUserAgent, z as ConnectError } from "./esm-BLeFQxnU.js";
//#region node_modules/@connectrpc/connect-web/dist/esm/assert-fetch-api.js
/**
* Asserts that the fetch API is available.
*/
function assertFetchApi() {
	try {
		new Headers();
	} catch (_) {
		throw new Error("connect-web requires the fetch API. Are you running on an old version of Node.js? Node.js is not supported in Connect for Web - please stay tuned for Connect for Node.");
	}
}
//#endregion
//#region node_modules/@connectrpc/connect-web/dist/esm/connect-transport.js
var __await$1 = function(v) {
	return this instanceof __await$1 ? (this.v = v, this) : new __await$1(v);
};
var __asyncGenerator$1 = function(thisArg, _arguments, generator) {
	if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
	var g = generator.apply(thisArg, _arguments || []), i, q = [];
	return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function() {
		return this;
	}, i;
	function awaitReturn(f) {
		return function(v) {
			return Promise.resolve(v).then(f, reject);
		};
	}
	function verb(n, f) {
		if (g[n]) {
			i[n] = function(v) {
				return new Promise(function(a, b) {
					q.push([
						n,
						v,
						a,
						b
					]) > 1 || resume(n, v);
				});
			};
			if (f) i[n] = f(i[n]);
		}
	}
	function resume(n, v) {
		try {
			step(g[n](v));
		} catch (e) {
			settle(q[0][3], e);
		}
	}
	function step(r) {
		r.value instanceof __await$1 ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r);
	}
	function fulfill(value) {
		resume("next", value);
	}
	function reject(value) {
		resume("throw", value);
	}
	function settle(f, v) {
		if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]);
	}
};
var fetchOptions$1 = { redirect: "error" };
/**
* Create a Transport for the Connect protocol, which makes unary and
* server-streaming methods available to web browsers. It uses the fetch
* API to make HTTP requests.
*/
function createConnectTransport(options) {
	var _a;
	assertFetchApi();
	const useBinaryFormat = (_a = options.useBinaryFormat) !== null && _a !== void 0 ? _a : false;
	return {
		async unary(method, signal, timeoutMs, header, message, contextValues) {
			const { serialize, parse } = createClientMethodSerializers(method, useBinaryFormat, options.jsonOptions, options.binaryOptions);
			timeoutMs = timeoutMs === void 0 ? options.defaultTimeoutMs : timeoutMs <= 0 ? void 0 : timeoutMs;
			return await runUnaryCall({
				interceptors: options.interceptors,
				signal,
				timeoutMs,
				req: {
					stream: false,
					service: method.parent,
					method,
					requestMethod: "POST",
					url: createMethodUrl(options.baseUrl, method),
					header: requestHeader$1(method.methodKind, useBinaryFormat, timeoutMs, header, false),
					contextValues: contextValues !== null && contextValues !== void 0 ? contextValues : createContextValues(),
					message
				},
				next: async (req) => {
					var _a;
					const useGet = options.useHttpGet === true && method.idempotency === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS;
					let body = null;
					if (useGet) req = transformConnectPostToGetRequest(req, serialize(req.message), useBinaryFormat);
					else body = serialize(req.message);
					const response = await ((_a = options.fetch) !== null && _a !== void 0 ? _a : globalThis.fetch)(req.url, Object.assign(Object.assign({}, fetchOptions$1), {
						method: req.requestMethod,
						headers: req.header,
						signal: req.signal,
						body
					}));
					const { isUnaryError, unaryError } = validateResponse$1(method.methodKind, useBinaryFormat, response.status, response.headers);
					if (isUnaryError) throw errorFromJson(await response.json(), appendHeaders(...trailerDemux(response.headers)), unaryError);
					const [demuxedHeader, demuxedTrailer] = trailerDemux(response.headers);
					return {
						stream: false,
						service: method.parent,
						method,
						header: demuxedHeader,
						message: useBinaryFormat ? parse(new Uint8Array(await response.arrayBuffer())) : fromJson(method.output, await response.json(), getJsonOptions(options.jsonOptions)),
						trailer: demuxedTrailer
					};
				}
			});
		},
		async stream(method, signal, timeoutMs, header, input, contextValues) {
			const { serialize, parse } = createClientMethodSerializers(method, useBinaryFormat, options.jsonOptions, options.binaryOptions);
			function parseResponseBody(body, trailerTarget, header, signal) {
				return __asyncGenerator$1(this, arguments, function* parseResponseBody_1() {
					const reader = createEnvelopeReadableStream(body).getReader();
					let endStreamReceived = false;
					for (;;) {
						const result = yield __await$1(reader.read());
						if (result.done) break;
						const { flags, data } = result.value;
						if ((flags & 1) === 1) throw new ConnectError(`protocol error: received unsupported compressed output`, Code.Internal);
						if ((flags & 2) === 2) {
							endStreamReceived = true;
							const endStream = endStreamFromJson(data);
							if (endStream.error) {
								const error = endStream.error;
								header.forEach((value, key) => {
									error.metadata.append(key, value);
								});
								throw error;
							}
							endStream.metadata.forEach((value, key) => trailerTarget.set(key, value));
							continue;
						}
						yield yield __await$1(parse(data));
					}
					if ("throwIfAborted" in signal) signal.throwIfAborted();
					if (!endStreamReceived) throw "missing EndStreamResponse";
				});
			}
			async function createRequestBody(input) {
				if (method.methodKind != "server_streaming") throw "The fetch API does not support streaming request bodies";
				const r = await input[Symbol.asyncIterator]().next();
				if (r.done == true) throw "missing request message";
				return encodeEnvelope(0, serialize(r.value));
			}
			timeoutMs = timeoutMs === void 0 ? options.defaultTimeoutMs : timeoutMs <= 0 ? void 0 : timeoutMs;
			return await runStreamingCall({
				interceptors: options.interceptors,
				timeoutMs,
				signal,
				req: {
					stream: true,
					service: method.parent,
					method,
					requestMethod: "POST",
					url: createMethodUrl(options.baseUrl, method),
					header: requestHeader$1(method.methodKind, useBinaryFormat, timeoutMs, header, false),
					contextValues: contextValues !== null && contextValues !== void 0 ? contextValues : createContextValues(),
					message: input
				},
				next: async (req) => {
					var _a;
					const fRes = await ((_a = options.fetch) !== null && _a !== void 0 ? _a : globalThis.fetch)(req.url, Object.assign(Object.assign({}, fetchOptions$1), {
						method: req.requestMethod,
						headers: req.header,
						signal: req.signal,
						body: await createRequestBody(req.message)
					}));
					validateResponse$1(method.methodKind, useBinaryFormat, fRes.status, fRes.headers);
					if (fRes.body === null) throw "missing response body";
					const trailer = new Headers();
					return Object.assign(Object.assign({}, req), {
						header: fRes.headers,
						trailer,
						message: parseResponseBody(fRes.body, trailer, fRes.headers, req.signal)
					});
				}
			});
		}
	};
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-grpc/validate-trailer.js
/**
* Validates a trailer for the gRPC and the gRPC-web protocol.
*
* If the trailer contains an error status, a ConnectError is
* thrown. It will include trailer and header in the error's
* "metadata" property.
*
* Throws a ConnectError with code "internal" if neither the trailer
* nor the header contain the Grpc-Status field.
*
* @private Internal code, does not follow semantic versioning.
*/
function validateTrailer(trailer, header) {
	const err = findTrailerError(trailer);
	if (err) {
		header.forEach((value, key) => {
			err.metadata.append(key, value);
		});
		throw err;
	}
	if (!header.has("Grpc-Status") && !trailer.has("Grpc-Status")) throw new ConnectError("protocol error: missing status", Code.Internal);
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-grpc-web/request-header.js
/**
* Creates headers for a gRPC-web request.
*
* @private Internal code, does not follow semantic versioning.
*/
function requestHeader(useBinaryFormat, timeoutMs, userProvidedHeaders, setUserAgent) {
	var _a, _b;
	const result = new Headers(userProvidedHeaders !== null && userProvidedHeaders !== void 0 ? userProvidedHeaders : {});
	result.set(headerContentType, useBinaryFormat ? contentTypeProto : contentTypeJson);
	result.set(headerXGrpcWeb, "1");
	const userAgent = (_b = (_a = result.get("User-Agent")) !== null && _a !== void 0 ? _a : result.get("X-User-Agent")) !== null && _b !== void 0 ? _b : "connect-es/2.1.1";
	result.set(headerXUserAgent, userAgent);
	if (setUserAgent) result.set(headerUserAgent, userAgent);
	if (timeoutMs !== void 0) result.set(headerTimeout, `${timeoutMs}m`);
	return result;
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-grpc/http-status.js
/**
* Determine the gRPC-web error code for the given HTTP status code.
* See https://github.com/grpc/grpc/blob/master/doc/http-grpc-status-mapping.md.
*
* @private Internal code, does not follow semantic versioning.
*/
function codeFromHttpStatus(httpStatus) {
	switch (httpStatus) {
		case 400: return Code.Internal;
		case 401: return Code.Unauthenticated;
		case 403: return Code.PermissionDenied;
		case 404: return Code.Unimplemented;
		case 429: return Code.Unavailable;
		case 502: return Code.Unavailable;
		case 503: return Code.Unavailable;
		case 504: return Code.Unavailable;
		default: return Code.Unknown;
	}
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-grpc-web/validate-response.js
/**
* Validates response status and header for the gRPC-web protocol.
*
* Throws a ConnectError if the header contains an error status,
* or if the HTTP status indicates an error.
*
* Returns an object that indicates whether a gRPC status was found
* in the response header. In this case, clients can not expect a
* trailer.
*
* @private Internal code, does not follow semantic versioning.
*/
function validateResponse(status, headers) {
	var _a;
	if (status >= 200 && status < 300) return {
		foundStatus: headers.has(headerGrpcStatus),
		headerError: findTrailerError(headers)
	};
	throw new ConnectError(decodeURIComponent((_a = headers.get("Grpc-Message")) !== null && _a !== void 0 ? _a : `HTTP ${status}`), codeFromHttpStatus(status), headers);
}
//#endregion
//#region node_modules/@connectrpc/connect-web/dist/esm/grpc-web-transport.js
var __await = function(v) {
	return this instanceof __await ? (this.v = v, this) : new __await(v);
};
var __asyncGenerator = function(thisArg, _arguments, generator) {
	if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
	var g = generator.apply(thisArg, _arguments || []), i, q = [];
	return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function() {
		return this;
	}, i;
	function awaitReturn(f) {
		return function(v) {
			return Promise.resolve(v).then(f, reject);
		};
	}
	function verb(n, f) {
		if (g[n]) {
			i[n] = function(v) {
				return new Promise(function(a, b) {
					q.push([
						n,
						v,
						a,
						b
					]) > 1 || resume(n, v);
				});
			};
			if (f) i[n] = f(i[n]);
		}
	}
	function resume(n, v) {
		try {
			step(g[n](v));
		} catch (e) {
			settle(q[0][3], e);
		}
	}
	function step(r) {
		r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r);
	}
	function fulfill(value) {
		resume("next", value);
	}
	function reject(value) {
		resume("throw", value);
	}
	function settle(f, v) {
		if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]);
	}
};
var fetchOptions = { redirect: "error" };
/**
* Create a Transport for the gRPC-web protocol. The protocol encodes
* trailers in the response body and makes unary and server-streaming
* methods available to web browsers. It uses the fetch API to make
* HTTP requests.
*
* Note that this transport does not implement the grpc-web-text format,
* which applies base64 encoding to the request and response bodies to
* support reading streaming responses from an XMLHttpRequest.
*/
function createGrpcWebTransport(options) {
	var _a;
	assertFetchApi();
	const useBinaryFormat = (_a = options.useBinaryFormat) !== null && _a !== void 0 ? _a : true;
	return {
		async unary(method, signal, timeoutMs, header, message, contextValues) {
			const { serialize, parse } = createClientMethodSerializers(method, useBinaryFormat, options.jsonOptions, options.binaryOptions);
			timeoutMs = timeoutMs === void 0 ? options.defaultTimeoutMs : timeoutMs <= 0 ? void 0 : timeoutMs;
			return await runUnaryCall({
				interceptors: options.interceptors,
				signal,
				timeoutMs,
				req: {
					stream: false,
					service: method.parent,
					method,
					requestMethod: "POST",
					url: createMethodUrl(options.baseUrl, method),
					header: requestHeader(useBinaryFormat, timeoutMs, header, false),
					contextValues: contextValues !== null && contextValues !== void 0 ? contextValues : createContextValues(),
					message
				},
				next: async (req) => {
					var _a;
					const response = await ((_a = options.fetch) !== null && _a !== void 0 ? _a : globalThis.fetch)(req.url, Object.assign(Object.assign({}, fetchOptions), {
						method: req.requestMethod,
						headers: req.header,
						signal: req.signal,
						body: encodeEnvelope(0, serialize(req.message))
					}));
					const { headerError } = validateResponse(response.status, response.headers);
					if (!response.body) {
						if (headerError !== void 0) throw headerError;
						throw "missing response body";
					}
					const reader = createEnvelopeReadableStream(response.body).getReader();
					let trailer;
					let message;
					for (;;) {
						const r = await reader.read();
						if (r.done) break;
						const { flags, data } = r.value;
						if ((flags & 1) === 1) throw new ConnectError(`protocol error: received unsupported compressed output`, Code.Internal);
						if (flags === 128) {
							if (trailer !== void 0) throw "extra trailer";
							trailer = trailerParse(data);
							continue;
						}
						if (message !== void 0) throw new ConnectError("extra message", Code.Unimplemented);
						message = parse(data);
					}
					if (trailer === void 0) {
						if (headerError !== void 0) throw headerError;
						throw new ConnectError("missing trailer", response.headers.has("Grpc-Status") ? Code.Unimplemented : Code.Unknown);
					}
					validateTrailer(trailer, response.headers);
					if (message === void 0) throw new ConnectError("missing message", trailer.has("Grpc-Status") ? Code.Unimplemented : Code.Unknown);
					return {
						stream: false,
						service: method.parent,
						method,
						header: response.headers,
						message,
						trailer
					};
				}
			});
		},
		async stream(method, signal, timeoutMs, header, input, contextValues) {
			const { serialize, parse } = createClientMethodSerializers(method, useBinaryFormat, options.jsonOptions, options.binaryOptions);
			function parseResponseBody(body, foundStatus, trailerTarget, header, signal) {
				return __asyncGenerator(this, arguments, function* parseResponseBody_1() {
					const reader = createEnvelopeReadableStream(body).getReader();
					if (foundStatus) {
						if (!(yield __await(reader.read())).done) throw "extra data for trailers-only";
						return yield __await(void 0);
					}
					let trailerReceived = false;
					for (;;) {
						const result = yield __await(reader.read());
						if (result.done) break;
						const { flags, data } = result.value;
						if ((flags & 128) === 128) {
							if (trailerReceived) throw "extra trailer";
							trailerReceived = true;
							const trailer = trailerParse(data);
							validateTrailer(trailer, header);
							trailer.forEach((value, key) => trailerTarget.set(key, value));
							continue;
						}
						if (trailerReceived) throw "extra message";
						yield yield __await(parse(data));
					}
					if ("throwIfAborted" in signal) signal.throwIfAborted();
					if (!trailerReceived) throw "missing trailer";
				});
			}
			async function createRequestBody(input) {
				if (method.methodKind != "server_streaming") throw "The fetch API does not support streaming request bodies";
				const r = await input[Symbol.asyncIterator]().next();
				if (r.done == true) throw "missing request message";
				return encodeEnvelope(0, serialize(r.value));
			}
			timeoutMs = timeoutMs === void 0 ? options.defaultTimeoutMs : timeoutMs <= 0 ? void 0 : timeoutMs;
			return runStreamingCall({
				interceptors: options.interceptors,
				signal,
				timeoutMs,
				req: {
					stream: true,
					service: method.parent,
					method,
					requestMethod: "POST",
					url: createMethodUrl(options.baseUrl, method),
					header: requestHeader(useBinaryFormat, timeoutMs, header, false),
					contextValues: contextValues !== null && contextValues !== void 0 ? contextValues : createContextValues(),
					message: input
				},
				next: async (req) => {
					var _a;
					const fRes = await ((_a = options.fetch) !== null && _a !== void 0 ? _a : globalThis.fetch)(req.url, Object.assign(Object.assign({}, fetchOptions), {
						method: req.requestMethod,
						headers: req.header,
						signal: req.signal,
						body: await createRequestBody(req.message)
					}));
					const { foundStatus, headerError } = validateResponse(fRes.status, fRes.headers);
					if (headerError != void 0) throw headerError;
					if (!fRes.body) throw "missing response body";
					const trailer = new Headers();
					return Object.assign(Object.assign({}, req), {
						header: fRes.headers,
						trailer,
						message: parseResponseBody(fRes.body, foundStatus, trailer, fRes.headers, req.signal)
					});
				}
			});
		}
	};
}
//#endregion
export { createConnectTransport, createGrpcWebTransport };
