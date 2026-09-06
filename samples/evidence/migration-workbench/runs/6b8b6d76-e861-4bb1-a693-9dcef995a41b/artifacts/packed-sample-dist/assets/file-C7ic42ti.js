//#region node_modules/@bufbuild/protobuf/dist/esm/is-message.js
/**
* Determine whether the given `arg` is a message.
* If `desc` is set, determine whether `arg` is this specific message.
*/
function isMessage(arg, schema) {
	if (!(arg !== null && typeof arg == "object" && "$typeName" in arg && typeof arg.$typeName == "string")) return false;
	if (schema === void 0) return true;
	return schema.typeName === arg.$typeName;
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/descriptors.js
/**
* Scalar value types. This is a subset of field types declared by protobuf
* enum google.protobuf.FieldDescriptorProto.Type The types GROUP and MESSAGE
* are omitted, but the numerical values are identical.
*/
var ScalarType;
(function(ScalarType) {
	ScalarType[ScalarType["DOUBLE"] = 1] = "DOUBLE";
	ScalarType[ScalarType["FLOAT"] = 2] = "FLOAT";
	ScalarType[ScalarType["INT64"] = 3] = "INT64";
	ScalarType[ScalarType["UINT64"] = 4] = "UINT64";
	ScalarType[ScalarType["INT32"] = 5] = "INT32";
	ScalarType[ScalarType["FIXED64"] = 6] = "FIXED64";
	ScalarType[ScalarType["FIXED32"] = 7] = "FIXED32";
	ScalarType[ScalarType["BOOL"] = 8] = "BOOL";
	ScalarType[ScalarType["STRING"] = 9] = "STRING";
	ScalarType[ScalarType["BYTES"] = 12] = "BYTES";
	ScalarType[ScalarType["UINT32"] = 13] = "UINT32";
	ScalarType[ScalarType["SFIXED32"] = 15] = "SFIXED32";
	ScalarType[ScalarType["SFIXED64"] = 16] = "SFIXED64";
	ScalarType[ScalarType["SINT32"] = 17] = "SINT32";
	ScalarType[ScalarType["SINT64"] = 18] = "SINT64";
})(ScalarType || (ScalarType = {}));
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/wire/varint.js
/**
* Read a 64 bit varint as two JS numbers.
*
* Returns tuple:
* [0]: low bits
* [1]: high bits
*
* Copyright 2008 Google Inc.  All rights reserved.
*
* See https://github.com/protocolbuffers/protobuf/blob/8a71927d74a4ce34efe2d8769fda198f52d20d12/js/experimental/runtime/kernel/buffer_decoder.js#L175
*/
function varint64read() {
	let lowBits = 0;
	let highBits = 0;
	for (let shift = 0; shift < 28; shift += 7) {
		let b = this.buf[this.pos++];
		lowBits |= (b & 127) << shift;
		if ((b & 128) == 0) {
			this.assertBounds();
			return [lowBits, highBits];
		}
	}
	let middleByte = this.buf[this.pos++];
	lowBits |= (middleByte & 15) << 28;
	highBits = (middleByte & 112) >> 4;
	if ((middleByte & 128) == 0) {
		this.assertBounds();
		return [lowBits, highBits];
	}
	for (let shift = 3; shift <= 31; shift += 7) {
		let b = this.buf[this.pos++];
		highBits |= (b & 127) << shift;
		if ((b & 128) == 0) {
			this.assertBounds();
			return [lowBits, highBits];
		}
	}
	throw new Error("invalid varint");
}
/**
* Write a 64 bit varint, given as two JS numbers, to the given bytes array.
*
* Copyright 2008 Google Inc.  All rights reserved.
*
* See https://github.com/protocolbuffers/protobuf/blob/8a71927d74a4ce34efe2d8769fda198f52d20d12/js/experimental/runtime/kernel/writer.js#L344
*/
function varint64write(lo, hi, bytes) {
	for (let i = 0; i < 28; i = i + 7) {
		const shift = lo >>> i;
		const hasNext = !(shift >>> 7 == 0 && hi == 0);
		const byte = (hasNext ? shift | 128 : shift) & 255;
		bytes.push(byte);
		if (!hasNext) return;
	}
	const splitBits = lo >>> 28 & 15 | (hi & 7) << 4;
	const hasMoreBits = !(hi >> 3 == 0);
	bytes.push((hasMoreBits ? splitBits | 128 : splitBits) & 255);
	if (!hasMoreBits) return;
	for (let i = 3; i < 31; i = i + 7) {
		const shift = hi >>> i;
		const hasNext = !(shift >>> 7 == 0);
		const byte = (hasNext ? shift | 128 : shift) & 255;
		bytes.push(byte);
		if (!hasNext) return;
	}
	bytes.push(hi >>> 31 & 1);
}
var TWO_PWR_32_DBL = 4294967296;
/**
* Parse decimal string of 64 bit integer value as two JS numbers.
*
* Copyright 2008 Google Inc.  All rights reserved.
*
* See https://github.com/protocolbuffers/protobuf-javascript/blob/a428c58273abad07c66071d9753bc4d1289de426/experimental/runtime/int64.js#L10
*/
function int64FromString(dec) {
	const minus = dec[0] === "-";
	if (minus) dec = dec.slice(1);
	const base = 1e6;
	let lowBits = 0;
	let highBits = 0;
	function add1e6digit(begin, end) {
		const digit1e6 = Number(dec.slice(begin, end));
		highBits *= base;
		lowBits = lowBits * base + digit1e6;
		if (lowBits >= TWO_PWR_32_DBL) {
			highBits = highBits + (lowBits / TWO_PWR_32_DBL | 0);
			lowBits = lowBits % TWO_PWR_32_DBL;
		}
	}
	add1e6digit(-24, -18);
	add1e6digit(-18, -12);
	add1e6digit(-12, -6);
	add1e6digit(-6);
	return minus ? negate(lowBits, highBits) : newBits(lowBits, highBits);
}
/**
* Losslessly converts a 64-bit signed integer in 32:32 split representation
* into a decimal string.
*
* Copyright 2008 Google Inc.  All rights reserved.
*
* See https://github.com/protocolbuffers/protobuf-javascript/blob/a428c58273abad07c66071d9753bc4d1289de426/experimental/runtime/int64.js#L10
*/
function int64ToString(lo, hi) {
	let bits = newBits(lo, hi);
	const negative = bits.hi & 2147483648;
	if (negative) bits = negate(bits.lo, bits.hi);
	const result = uInt64ToString(bits.lo, bits.hi);
	return negative ? "-" + result : result;
}
/**
* Losslessly converts a 64-bit unsigned integer in 32:32 split representation
* into a decimal string.
*
* Copyright 2008 Google Inc.  All rights reserved.
*
* See https://github.com/protocolbuffers/protobuf-javascript/blob/a428c58273abad07c66071d9753bc4d1289de426/experimental/runtime/int64.js#L10
*/
function uInt64ToString(lo, hi) {
	({lo, hi} = toUnsigned(lo, hi));
	if (hi <= 2097151) return String(TWO_PWR_32_DBL * hi + lo);
	const low = lo & 16777215;
	const mid = (lo >>> 24 | hi << 8) & 16777215;
	const high = hi >> 16 & 65535;
	let digitA = low + mid * 6777216 + high * 6710656;
	let digitB = mid + high * 8147497;
	let digitC = high * 2;
	const base = 1e7;
	if (digitA >= base) {
		digitB += Math.floor(digitA / base);
		digitA %= base;
	}
	if (digitB >= base) {
		digitC += Math.floor(digitB / base);
		digitB %= base;
	}
	return digitC.toString() + decimalFrom1e7WithLeadingZeros(digitB) + decimalFrom1e7WithLeadingZeros(digitA);
}
function toUnsigned(lo, hi) {
	return {
		lo: lo >>> 0,
		hi: hi >>> 0
	};
}
function newBits(lo, hi) {
	return {
		lo: lo | 0,
		hi: hi | 0
	};
}
/**
* Returns two's compliment negation of input.
* @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Bitwise_Operators#Signed_32-bit_integers
*/
function negate(lowBits, highBits) {
	highBits = ~highBits;
	if (lowBits) lowBits = ~lowBits + 1;
	else highBits += 1;
	return newBits(lowBits, highBits);
}
/**
* Returns decimal representation of digit1e7 with leading zeros.
*/
var decimalFrom1e7WithLeadingZeros = (digit1e7) => {
	const partial = String(digit1e7);
	return "0000000".slice(partial.length) + partial;
};
/**
* Write a 32 bit varint, signed or unsigned. Same as `varint64write(0, value, bytes)`
*
* Copyright 2008 Google Inc.  All rights reserved.
*
* See https://github.com/protocolbuffers/protobuf/blob/1b18833f4f2a2f681f4e4a25cdf3b0a43115ec26/js/binary/encoder.js#L144
*/
function varint32write(value, bytes) {
	if (value >= 0) {
		while (value > 127) {
			bytes.push(value & 127 | 128);
			value = value >>> 7;
		}
		bytes.push(value);
	} else {
		for (let i = 0; i < 9; i++) {
			bytes.push(value & 127 | 128);
			value = value >> 7;
		}
		bytes.push(1);
	}
}
/**
* Read an unsigned 32 bit varint.
*
* See https://github.com/protocolbuffers/protobuf/blob/8a71927d74a4ce34efe2d8769fda198f52d20d12/js/experimental/runtime/kernel/buffer_decoder.js#L220
*/
function varint32read() {
	let b = this.buf[this.pos++];
	let result = b & 127;
	if ((b & 128) == 0) {
		this.assertBounds();
		return result;
	}
	b = this.buf[this.pos++];
	result |= (b & 127) << 7;
	if ((b & 128) == 0) {
		this.assertBounds();
		return result;
	}
	b = this.buf[this.pos++];
	result |= (b & 127) << 14;
	if ((b & 128) == 0) {
		this.assertBounds();
		return result;
	}
	b = this.buf[this.pos++];
	result |= (b & 127) << 21;
	if ((b & 128) == 0) {
		this.assertBounds();
		return result;
	}
	b = this.buf[this.pos++];
	result |= (b & 15) << 28;
	for (let readBytes = 5; (b & 128) !== 0 && readBytes < 10; readBytes++) b = this.buf[this.pos++];
	if ((b & 128) != 0) throw new Error("invalid varint");
	this.assertBounds();
	return result >>> 0;
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/proto-int64.js
/**
* Int64Support for the current environment.
*/
var protoInt64 = /*@__PURE__*/ makeInt64Support();
function makeInt64Support() {
	const dv = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(8));
	if (typeof BigInt === "function" && typeof dv.getBigInt64 === "function" && typeof dv.getBigUint64 === "function" && typeof dv.setBigInt64 === "function" && typeof dv.setBigUint64 === "function" && (!!globalThis.Deno || typeof process != "object" || {}.BUF_BIGINT_DISABLE !== "1")) {
		const MIN = BigInt("-9223372036854775808");
		const MAX = BigInt("9223372036854775807");
		const UMIN = BigInt("0");
		const UMAX = BigInt("18446744073709551615");
		return {
			zero: BigInt(0),
			supported: true,
			parse(value) {
				const bi = typeof value == "bigint" ? value : BigInt(value);
				if (bi > MAX || bi < MIN) throw new Error(`invalid int64: ${value}`);
				return bi;
			},
			uParse(value) {
				const bi = typeof value == "bigint" ? value : BigInt(value);
				if (bi > UMAX || bi < UMIN) throw new Error(`invalid uint64: ${value}`);
				return bi;
			},
			enc(value) {
				dv.setBigInt64(0, this.parse(value), true);
				return {
					lo: dv.getInt32(0, true),
					hi: dv.getInt32(4, true)
				};
			},
			uEnc(value) {
				dv.setBigInt64(0, this.uParse(value), true);
				return {
					lo: dv.getInt32(0, true),
					hi: dv.getInt32(4, true)
				};
			},
			dec(lo, hi) {
				dv.setInt32(0, lo, true);
				dv.setInt32(4, hi, true);
				return dv.getBigInt64(0, true);
			},
			uDec(lo, hi) {
				dv.setInt32(0, lo, true);
				dv.setInt32(4, hi, true);
				return dv.getBigUint64(0, true);
			}
		};
	}
	return {
		zero: "0",
		supported: false,
		parse(value) {
			if (typeof value != "string") value = value.toString();
			assertInt64String(value);
			return value;
		},
		uParse(value) {
			if (typeof value != "string") value = value.toString();
			assertUInt64String(value);
			return value;
		},
		enc(value) {
			if (typeof value != "string") value = value.toString();
			assertInt64String(value);
			return int64FromString(value);
		},
		uEnc(value) {
			if (typeof value != "string") value = value.toString();
			assertUInt64String(value);
			return int64FromString(value);
		},
		dec(lo, hi) {
			return int64ToString(lo, hi);
		},
		uDec(lo, hi) {
			return uInt64ToString(lo, hi);
		}
	};
}
function assertInt64String(value) {
	if (!/^-?[0-9]+$/.test(value)) throw new Error("invalid int64: " + value);
}
function assertUInt64String(value) {
	if (!/^[0-9]+$/.test(value)) throw new Error("invalid uint64: " + value);
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/reflect/scalar.js
/**
* Returns the zero value for the given scalar type.
*/
function scalarZeroValue(type, longAsString) {
	switch (type) {
		case ScalarType.STRING: return "";
		case ScalarType.BOOL: return false;
		case ScalarType.DOUBLE:
		case ScalarType.FLOAT: return 0;
		case ScalarType.INT64:
		case ScalarType.UINT64:
		case ScalarType.SFIXED64:
		case ScalarType.FIXED64:
		case ScalarType.SINT64: return longAsString ? "0" : protoInt64.zero;
		case ScalarType.BYTES: return new Uint8Array(0);
		default: return 0;
	}
}
/**
* Returns true for a zero-value. For example, an integer has the zero-value `0`,
* a boolean is `false`, a string is `""`, and bytes is an empty Uint8Array.
*
* In proto3, zero-values are not written to the wire, unless the field is
* optional or repeated.
*/
function isScalarZeroValue(type, value) {
	switch (type) {
		case ScalarType.BOOL: return value === false;
		case ScalarType.STRING: return value === "";
		case ScalarType.BYTES: return value instanceof Uint8Array && !value.byteLength;
		default: return value == 0;
	}
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/reflect/unsafe.js
var IMPLICIT$2 = 2;
var unsafeLocal = Symbol.for("reflect unsafe local");
/**
* Return the selected field of a oneof group.
*
* @private
*/
function unsafeOneofCase(target, oneof) {
	const c = target[oneof.localName].case;
	if (c === void 0) return c;
	return oneof.fields.find((f) => f.localName === c);
}
/**
* Returns true if the field is set.
*
* @private
*/
function unsafeIsSet(target, field) {
	const name = field.localName;
	if (field.oneof) return target[field.oneof.localName].case === name;
	if (field.presence != IMPLICIT$2) return target[name] !== void 0 && Object.prototype.hasOwnProperty.call(target, name);
	switch (field.fieldKind) {
		case "list": return target[name].length > 0;
		case "map": return Object.keys(target[name]).length > 0;
		case "scalar": return !isScalarZeroValue(field.scalar, target[name]);
		case "enum": return target[name] !== field.enum.values[0].number;
	}
	throw new Error("message field with implicit presence");
}
/**
* Returns true if the field is set, but only for singular fields with explicit
* presence (proto2).
*
* @private
*/
function unsafeIsSetExplicit(target, localName) {
	return Object.prototype.hasOwnProperty.call(target, localName) && target[localName] !== void 0;
}
/**
* Return a field value, respecting oneof groups.
*
* @private
*/
function unsafeGet(target, field) {
	if (field.oneof) {
		const oneof = target[field.oneof.localName];
		if (oneof.case === field.localName) return oneof.value;
		return;
	}
	return target[field.localName];
}
/**
* Set a field value, respecting oneof groups.
*
* @private
*/
function unsafeSet(target, field, value) {
	if (field.oneof) target[field.oneof.localName] = {
		case: field.localName,
		value
	};
	else target[field.localName] = value;
}
/**
* Resets the field, so that unsafeIsSet() will return false.
*
* @private
*/
function unsafeClear(target, field) {
	const name = field.localName;
	if (field.oneof) {
		const oneofLocalName = field.oneof.localName;
		if (target[oneofLocalName].case === name) target[oneofLocalName] = { case: void 0 };
	} else if (field.presence != IMPLICIT$2) delete target[name];
	else switch (field.fieldKind) {
		case "map":
			target[name] = {};
			break;
		case "list":
			target[name] = [];
			break;
		case "enum":
			target[name] = field.enum.values[0].number;
			break;
		case "scalar":
			target[name] = scalarZeroValue(field.scalar, field.longAsString);
			break;
	}
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/reflect/guard.js
function isObject(arg) {
	return arg !== null && typeof arg == "object" && !Array.isArray(arg);
}
function isReflectList(arg, field) {
	var _a, _b, _c, _d;
	if (isObject(arg) && unsafeLocal in arg && "add" in arg && "field" in arg && typeof arg.field == "function") {
		if (field !== void 0) {
			const a = field;
			const b = arg.field();
			return a.listKind == b.listKind && a.scalar === b.scalar && ((_a = a.message) === null || _a === void 0 ? void 0 : _a.typeName) === ((_b = b.message) === null || _b === void 0 ? void 0 : _b.typeName) && ((_c = a.enum) === null || _c === void 0 ? void 0 : _c.typeName) === ((_d = b.enum) === null || _d === void 0 ? void 0 : _d.typeName);
		}
		return true;
	}
	return false;
}
function isReflectMap(arg, field) {
	var _a, _b, _c, _d;
	if (isObject(arg) && unsafeLocal in arg && "has" in arg && "field" in arg && typeof arg.field == "function") {
		if (field !== void 0) {
			const a = field, b = arg.field();
			return a.mapKey === b.mapKey && a.mapKind == b.mapKind && a.scalar === b.scalar && ((_a = a.message) === null || _a === void 0 ? void 0 : _a.typeName) === ((_b = b.message) === null || _b === void 0 ? void 0 : _b.typeName) && ((_c = a.enum) === null || _c === void 0 ? void 0 : _c.typeName) === ((_d = b.enum) === null || _d === void 0 ? void 0 : _d.typeName);
		}
		return true;
	}
	return false;
}
function isReflectMessage(arg, messageDesc) {
	return isObject(arg) && unsafeLocal in arg && "desc" in arg && isObject(arg.desc) && arg.desc.kind === "message" && (messageDesc === void 0 || arg.desc.typeName == messageDesc.typeName);
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/wkt/wrappers.js
function isWrapper(arg) {
	return isWrapperTypeName(arg.$typeName);
}
function isWrapperDesc(messageDesc) {
	const f = messageDesc.fields[0];
	return isWrapperTypeName(messageDesc.typeName) && f !== void 0 && f.fieldKind == "scalar" && f.name == "value" && f.number == 1;
}
function isWrapperTypeName(name) {
	return name.startsWith("google.protobuf.") && [
		"DoubleValue",
		"FloatValue",
		"Int64Value",
		"UInt64Value",
		"Int32Value",
		"UInt32Value",
		"BoolValue",
		"StringValue",
		"BytesValue"
	].includes(name.substring(16));
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/create.js
var EDITION_PROTO3$1 = 999;
var EDITION_PROTO2$1 = 998;
var IMPLICIT$1 = 2;
/**
* Create a new message instance.
*
* The second argument is an optional initializer object, where all fields are
* optional.
*/
function create(schema, init) {
	if (isMessage(init, schema)) return init;
	const message = createZeroMessage(schema);
	if (init !== void 0) initMessage(schema, message, init);
	return message;
}
/**
* Sets field values from a MessageInitShape on a zero message.
*/
function initMessage(messageDesc, message, init) {
	for (const member of messageDesc.members) {
		let value = init[member.localName];
		if (value == null) continue;
		let field;
		if (member.kind == "oneof") {
			const oneofField = unsafeOneofCase(init, member);
			if (!oneofField) continue;
			field = oneofField;
			value = unsafeGet(init, oneofField);
		} else field = member;
		switch (field.fieldKind) {
			case "message":
				value = toMessage(field, value);
				break;
			case "scalar":
				value = initScalar(field, value);
				break;
			case "list":
				value = initList(field, value);
				break;
			case "map":
				value = initMap(field, value);
				break;
		}
		unsafeSet(message, field, value);
	}
	return message;
}
function initScalar(field, value) {
	if (field.scalar == ScalarType.BYTES) return toU8Arr(value);
	return value;
}
function initMap(field, value) {
	if (isObject(value)) {
		if (field.scalar == ScalarType.BYTES) return convertObjectValues(value, toU8Arr);
		if (field.mapKind == "message") return convertObjectValues(value, (val) => toMessage(field, val));
	}
	return value;
}
function initList(field, value) {
	if (Array.isArray(value)) {
		if (field.scalar == ScalarType.BYTES) return value.map(toU8Arr);
		if (field.listKind == "message") return value.map((item) => toMessage(field, item));
	}
	return value;
}
function toMessage(field, value) {
	if (field.fieldKind == "message" && !field.oneof && isWrapperDesc(field.message)) return initScalar(field.message.fields[0], value);
	if (isObject(value)) {
		if (field.message.typeName == "google.protobuf.Struct" && field.parent.typeName !== "google.protobuf.Value") return value;
		if (!isMessage(value, field.message)) return create(field.message, value);
	}
	return value;
}
function toU8Arr(value) {
	return Array.isArray(value) ? new Uint8Array(value) : value;
}
function convertObjectValues(obj, fn) {
	const ret = {};
	for (const entry of Object.entries(obj)) ret[entry[0]] = fn(entry[1]);
	return ret;
}
var tokenZeroMessageField = Symbol();
var messagePrototypes = /* @__PURE__ */ new WeakMap();
/**
* Create a zero message.
*/
function createZeroMessage(desc) {
	let msg;
	if (!needsPrototypeChain(desc)) {
		msg = { $typeName: desc.typeName };
		for (const member of desc.members) if (member.kind == "oneof" || member.presence == IMPLICIT$1) msg[member.localName] = createZeroField(member);
	} else {
		const cached = messagePrototypes.get(desc);
		let prototype;
		let members;
		if (cached) ({prototype, members} = cached);
		else {
			prototype = {};
			members = /* @__PURE__ */ new Set();
			for (const member of desc.members) {
				if (member.kind == "oneof") continue;
				if (member.fieldKind != "scalar" && member.fieldKind != "enum") continue;
				if (member.presence == IMPLICIT$1) continue;
				members.add(member);
				prototype[member.localName] = createZeroField(member);
			}
			messagePrototypes.set(desc, {
				prototype,
				members
			});
		}
		msg = Object.create(prototype);
		msg.$typeName = desc.typeName;
		for (const member of desc.members) {
			if (members.has(member)) continue;
			if (member.kind == "field") {
				if (member.fieldKind == "message") continue;
				if (member.fieldKind == "scalar" || member.fieldKind == "enum") {
					if (member.presence != IMPLICIT$1) continue;
				}
			}
			msg[member.localName] = createZeroField(member);
		}
	}
	return msg;
}
/**
* Do we need the prototype chain to track field presence?
*/
function needsPrototypeChain(desc) {
	switch (desc.file.edition) {
		case EDITION_PROTO3$1: return false;
		case EDITION_PROTO2$1: return true;
		default: return desc.fields.some((f) => f.presence != IMPLICIT$1 && f.fieldKind != "message" && !f.oneof);
	}
}
/**
* Returns a zero value for oneof groups, and for every field kind except
* messages. Scalar and enum fields can have default values.
*/
function createZeroField(field) {
	if (field.kind == "oneof") return { case: void 0 };
	if (field.fieldKind == "list") return [];
	if (field.fieldKind == "map") return {};
	if (field.fieldKind == "message") return tokenZeroMessageField;
	const defaultValue = field.getDefaultValue();
	if (defaultValue !== void 0) return field.fieldKind == "scalar" && field.longAsString ? defaultValue.toString() : defaultValue;
	return field.fieldKind == "scalar" ? scalarZeroValue(field.scalar, field.longAsString) : field.enum.values[0].number;
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/reflect/error.js
var errorNames = [
	"FieldValueInvalidError",
	"FieldListRangeError",
	"ForeignFieldError"
];
var FieldError = class extends Error {
	constructor(fieldOrOneof, message, name = "FieldValueInvalidError") {
		super(message);
		this.name = name;
		this.field = () => fieldOrOneof;
	}
};
function isFieldError(arg) {
	return arg instanceof Error && errorNames.includes(arg.name) && "field" in arg && typeof arg.field == "function";
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/wire/text-encoding.js
var symbol = Symbol.for("@bufbuild/protobuf/text-encoding");
function getTextEncoding() {
	if (globalThis[symbol] == void 0) {
		const te = new globalThis.TextEncoder();
		const td = new globalThis.TextDecoder();
		globalThis[symbol] = {
			encodeUtf8(text) {
				return te.encode(text);
			},
			decodeUtf8(bytes) {
				return td.decode(bytes);
			},
			checkUtf8(text) {
				try {
					return true;
				} catch (_) {
					return false;
				}
			}
		};
	}
	return globalThis[symbol];
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/wire/binary-encoding.js
/**
* Protobuf binary format wire types.
*
* A wire type provides just enough information to find the length of the
* following value.
*
* See https://developers.google.com/protocol-buffers/docs/encoding#structure
*/
var WireType;
(function(WireType) {
	/**
	* Used for int32, int64, uint32, uint64, sint32, sint64, bool, enum
	*/
	WireType[WireType["Varint"] = 0] = "Varint";
	/**
	* Used for fixed64, sfixed64, double.
	* Always 8 bytes with little-endian byte order.
	*/
	WireType[WireType["Bit64"] = 1] = "Bit64";
	/**
	* Used for string, bytes, embedded messages, packed repeated fields
	*
	* Only repeated numeric types (types which use the varint, 32-bit,
	* or 64-bit wire types) can be packed. In proto3, such fields are
	* packed by default.
	*/
	WireType[WireType["LengthDelimited"] = 2] = "LengthDelimited";
	/**
	* Start of a tag-delimited aggregate, such as a proto2 group, or a message
	* in editions with message_encoding = DELIMITED.
	*/
	WireType[WireType["StartGroup"] = 3] = "StartGroup";
	/**
	* End of a tag-delimited aggregate.
	*/
	WireType[WireType["EndGroup"] = 4] = "EndGroup";
	/**
	* Used for fixed32, sfixed32, float.
	* Always 4 bytes with little-endian byte order.
	*/
	WireType[WireType["Bit32"] = 5] = "Bit32";
})(WireType || (WireType = {}));
var BinaryWriter = class {
	constructor(encodeUtf8 = getTextEncoding().encodeUtf8) {
		this.encodeUtf8 = encodeUtf8;
		/**
		* Previous fork states.
		*/
		this.stack = [];
		this.chunks = [];
		this.buf = [];
	}
	/**
	* Return all bytes written and reset this writer.
	*/
	finish() {
		if (this.buf.length) {
			this.chunks.push(new Uint8Array(this.buf));
			this.buf = [];
		}
		let len = 0;
		for (let i = 0; i < this.chunks.length; i++) len += this.chunks[i].length;
		let bytes = new Uint8Array(len);
		let offset = 0;
		for (let i = 0; i < this.chunks.length; i++) {
			bytes.set(this.chunks[i], offset);
			offset += this.chunks[i].length;
		}
		this.chunks = [];
		return bytes;
	}
	/**
	* Start a new fork for length-delimited data like a message
	* or a packed repeated field.
	*
	* Must be joined later with `join()`.
	*/
	fork() {
		this.stack.push({
			chunks: this.chunks,
			buf: this.buf
		});
		this.chunks = [];
		this.buf = [];
		return this;
	}
	/**
	* Join the last fork. Write its length and bytes, then
	* return to the previous state.
	*/
	join() {
		let chunk = this.finish();
		let prev = this.stack.pop();
		if (!prev) throw new Error("invalid state, fork stack empty");
		this.chunks = prev.chunks;
		this.buf = prev.buf;
		this.uint32(chunk.byteLength);
		return this.raw(chunk);
	}
	/**
	* Writes a tag (field number and wire type).
	*
	* Equivalent to `uint32( (fieldNo << 3 | type) >>> 0 )`.
	*
	* Generated code should compute the tag ahead of time and call `uint32()`.
	*/
	tag(fieldNo, type) {
		return this.uint32((fieldNo << 3 | type) >>> 0);
	}
	/**
	* Write a chunk of raw bytes.
	*/
	raw(chunk) {
		if (this.buf.length) {
			this.chunks.push(new Uint8Array(this.buf));
			this.buf = [];
		}
		this.chunks.push(chunk);
		return this;
	}
	/**
	* Write a `uint32` value, an unsigned 32 bit varint.
	*/
	uint32(value) {
		assertUInt32(value);
		while (value > 127) {
			this.buf.push(value & 127 | 128);
			value = value >>> 7;
		}
		this.buf.push(value);
		return this;
	}
	/**
	* Write a `int32` value, a signed 32 bit varint.
	*/
	int32(value) {
		assertInt32(value);
		varint32write(value, this.buf);
		return this;
	}
	/**
	* Write a `bool` value, a variant.
	*/
	bool(value) {
		this.buf.push(value ? 1 : 0);
		return this;
	}
	/**
	* Write a `bytes` value, length-delimited arbitrary data.
	*/
	bytes(value) {
		this.uint32(value.byteLength);
		return this.raw(value);
	}
	/**
	* Write a `string` value, length-delimited data converted to UTF-8 text.
	*/
	string(value) {
		let chunk = this.encodeUtf8(value);
		this.uint32(chunk.byteLength);
		return this.raw(chunk);
	}
	/**
	* Write a `float` value, 32-bit floating point number.
	*/
	float(value) {
		assertFloat32(value);
		let chunk = new Uint8Array(4);
		new DataView(chunk.buffer).setFloat32(0, value, true);
		return this.raw(chunk);
	}
	/**
	* Write a `double` value, a 64-bit floating point number.
	*/
	double(value) {
		let chunk = new Uint8Array(8);
		new DataView(chunk.buffer).setFloat64(0, value, true);
		return this.raw(chunk);
	}
	/**
	* Write a `fixed32` value, an unsigned, fixed-length 32-bit integer.
	*/
	fixed32(value) {
		assertUInt32(value);
		let chunk = new Uint8Array(4);
		new DataView(chunk.buffer).setUint32(0, value, true);
		return this.raw(chunk);
	}
	/**
	* Write a `sfixed32` value, a signed, fixed-length 32-bit integer.
	*/
	sfixed32(value) {
		assertInt32(value);
		let chunk = new Uint8Array(4);
		new DataView(chunk.buffer).setInt32(0, value, true);
		return this.raw(chunk);
	}
	/**
	* Write a `sint32` value, a signed, zigzag-encoded 32-bit varint.
	*/
	sint32(value) {
		assertInt32(value);
		value = (value << 1 ^ value >> 31) >>> 0;
		varint32write(value, this.buf);
		return this;
	}
	/**
	* Write a `fixed64` value, a signed, fixed-length 64-bit integer.
	*/
	sfixed64(value) {
		let chunk = new Uint8Array(8), view = new DataView(chunk.buffer), tc = protoInt64.enc(value);
		view.setInt32(0, tc.lo, true);
		view.setInt32(4, tc.hi, true);
		return this.raw(chunk);
	}
	/**
	* Write a `fixed64` value, an unsigned, fixed-length 64 bit integer.
	*/
	fixed64(value) {
		let chunk = new Uint8Array(8), view = new DataView(chunk.buffer), tc = protoInt64.uEnc(value);
		view.setInt32(0, tc.lo, true);
		view.setInt32(4, tc.hi, true);
		return this.raw(chunk);
	}
	/**
	* Write a `int64` value, a signed 64-bit varint.
	*/
	int64(value) {
		let tc = protoInt64.enc(value);
		varint64write(tc.lo, tc.hi, this.buf);
		return this;
	}
	/**
	* Write a `sint64` value, a signed, zig-zag-encoded 64-bit varint.
	*/
	sint64(value) {
		const tc = protoInt64.enc(value), sign = tc.hi >> 31;
		varint64write(tc.lo << 1 ^ sign, (tc.hi << 1 | tc.lo >>> 31) ^ sign, this.buf);
		return this;
	}
	/**
	* Write a `uint64` value, an unsigned 64-bit varint.
	*/
	uint64(value) {
		const tc = protoInt64.uEnc(value);
		varint64write(tc.lo, tc.hi, this.buf);
		return this;
	}
};
var BinaryReader = class {
	constructor(buf, decodeUtf8 = getTextEncoding().decodeUtf8) {
		this.decodeUtf8 = decodeUtf8;
		this.varint64 = varint64read;
		/**
		* Read a `uint32` field, an unsigned 32 bit varint.
		*/
		this.uint32 = varint32read;
		this.buf = buf;
		this.len = buf.length;
		this.pos = 0;
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	/**
	* Reads a tag - field number and wire type.
	*/
	tag() {
		let tag = this.uint32(), fieldNo = tag >>> 3, wireType = tag & 7;
		if (fieldNo <= 0 || wireType < 0 || wireType > 5) throw new Error("illegal tag: field no " + fieldNo + " wire type " + wireType);
		return [fieldNo, wireType];
	}
	/**
	* Skip one element and return the skipped data.
	*
	* When skipping StartGroup, provide the tags field number to check for
	* matching field number in the EndGroup tag.
	*/
	skip(wireType, fieldNo) {
		let start = this.pos;
		switch (wireType) {
			case WireType.Varint:
				while (this.buf[this.pos++] & 128);
				break;
			case WireType.Bit64: this.pos += 4;
			case WireType.Bit32:
				this.pos += 4;
				break;
			case WireType.LengthDelimited:
				let len = this.uint32();
				this.pos += len;
				break;
			case WireType.StartGroup:
				for (;;) {
					const [fn, wt] = this.tag();
					if (wt === WireType.EndGroup) {
						if (fieldNo !== void 0 && fn !== fieldNo) throw new Error("invalid end group tag");
						break;
					}
					this.skip(wt, fn);
				}
				break;
			default: throw new Error("cant skip wire type " + wireType);
		}
		this.assertBounds();
		return this.buf.subarray(start, this.pos);
	}
	/**
	* Throws error if position in byte array is out of range.
	*/
	assertBounds() {
		if (this.pos > this.len) throw new RangeError("premature EOF");
	}
	/**
	* Read a `int32` field, a signed 32 bit varint.
	*/
	int32() {
		return this.uint32() | 0;
	}
	/**
	* Read a `sint32` field, a signed, zigzag-encoded 32-bit varint.
	*/
	sint32() {
		let zze = this.uint32();
		return zze >>> 1 ^ -(zze & 1);
	}
	/**
	* Read a `int64` field, a signed 64-bit varint.
	*/
	int64() {
		return protoInt64.dec(...this.varint64());
	}
	/**
	* Read a `uint64` field, an unsigned 64-bit varint.
	*/
	uint64() {
		return protoInt64.uDec(...this.varint64());
	}
	/**
	* Read a `sint64` field, a signed, zig-zag-encoded 64-bit varint.
	*/
	sint64() {
		let [lo, hi] = this.varint64();
		let s = -(lo & 1);
		lo = (lo >>> 1 | (hi & 1) << 31) ^ s;
		hi = hi >>> 1 ^ s;
		return protoInt64.dec(lo, hi);
	}
	/**
	* Read a `bool` field, a variant.
	*/
	bool() {
		let [lo, hi] = this.varint64();
		return lo !== 0 || hi !== 0;
	}
	/**
	* Read a `fixed32` field, an unsigned, fixed-length 32-bit integer.
	*/
	fixed32() {
		return this.view.getUint32((this.pos += 4) - 4, true);
	}
	/**
	* Read a `sfixed32` field, a signed, fixed-length 32-bit integer.
	*/
	sfixed32() {
		return this.view.getInt32((this.pos += 4) - 4, true);
	}
	/**
	* Read a `fixed64` field, an unsigned, fixed-length 64 bit integer.
	*/
	fixed64() {
		return protoInt64.uDec(this.sfixed32(), this.sfixed32());
	}
	/**
	* Read a `fixed64` field, a signed, fixed-length 64-bit integer.
	*/
	sfixed64() {
		return protoInt64.dec(this.sfixed32(), this.sfixed32());
	}
	/**
	* Read a `float` field, 32-bit floating point number.
	*/
	float() {
		return this.view.getFloat32((this.pos += 4) - 4, true);
	}
	/**
	* Read a `double` field, a 64-bit floating point number.
	*/
	double() {
		return this.view.getFloat64((this.pos += 8) - 8, true);
	}
	/**
	* Read a `bytes` field, length-delimited arbitrary data.
	*/
	bytes() {
		let len = this.uint32(), start = this.pos;
		this.pos += len;
		this.assertBounds();
		return this.buf.subarray(start, start + len);
	}
	/**
	* Read a `string` field, length-delimited data converted to UTF-8 text.
	*/
	string() {
		return this.decodeUtf8(this.bytes());
	}
};
/**
* Assert a valid signed protobuf 32-bit integer as a number or string.
*/
function assertInt32(arg) {
	if (typeof arg == "string") arg = Number(arg);
	else if (typeof arg != "number") throw new Error("invalid int32: " + typeof arg);
	if (!Number.isInteger(arg) || arg > 2147483647 || arg < -2147483648) throw new Error("invalid int32: " + arg);
}
/**
* Assert a valid unsigned protobuf 32-bit integer as a number or string.
*/
function assertUInt32(arg) {
	if (typeof arg == "string") arg = Number(arg);
	else if (typeof arg != "number") throw new Error("invalid uint32: " + typeof arg);
	if (!Number.isInteger(arg) || arg > 4294967295 || arg < 0) throw new Error("invalid uint32: " + arg);
}
/**
* Assert a valid protobuf float value as a number or string.
*/
function assertFloat32(arg) {
	if (typeof arg == "string") {
		const o = arg;
		arg = Number(arg);
		if (Number.isNaN(arg) && o !== "NaN") throw new Error("invalid float32: " + o);
	} else if (typeof arg != "number") throw new Error("invalid float32: " + typeof arg);
	if (Number.isFinite(arg) && (arg > 34028234663852886e22 || arg < -34028234663852886e22)) throw new Error("invalid float32: " + arg);
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/reflect/reflect-check.js
/**
* Check whether the given field value is valid for the reflect API.
*/
function checkField(field, value) {
	const check = field.fieldKind == "list" ? isReflectList(value, field) : field.fieldKind == "map" ? isReflectMap(value, field) : checkSingular(field, value);
	if (check === true) return;
	let reason;
	switch (field.fieldKind) {
		case "list":
			reason = `expected ${formatReflectList(field)}, got ${formatVal(value)}`;
			break;
		case "map":
			reason = `expected ${formatReflectMap(field)}, got ${formatVal(value)}`;
			break;
		default: reason = reasonSingular(field, value, check);
	}
	return new FieldError(field, reason);
}
/**
* Check whether the given list item is valid for the reflect API.
*/
function checkListItem(field, index, value) {
	const check = checkSingular(field, value);
	if (check !== true) return new FieldError(field, `list item #${index + 1}: ${reasonSingular(field, value, check)}`);
}
/**
* Check whether the given map key and value are valid for the reflect API.
*/
function checkMapEntry(field, key, value) {
	const checkKey = checkScalarValue(key, field.mapKey);
	if (checkKey !== true) return new FieldError(field, `invalid map key: ${reasonSingular({ scalar: field.mapKey }, key, checkKey)}`);
	const checkVal = checkSingular(field, value);
	if (checkVal !== true) return new FieldError(field, `map entry ${formatVal(key)}: ${reasonSingular(field, value, checkVal)}`);
}
function checkSingular(field, value) {
	if (field.scalar !== void 0) return checkScalarValue(value, field.scalar);
	if (field.enum !== void 0) {
		if (field.enum.open) return Number.isInteger(value);
		return field.enum.values.some((v) => v.number === value);
	}
	return isReflectMessage(value, field.message);
}
function checkScalarValue(value, scalar) {
	switch (scalar) {
		case ScalarType.DOUBLE: return typeof value == "number";
		case ScalarType.FLOAT:
			if (typeof value != "number") return false;
			if (Number.isNaN(value) || !Number.isFinite(value)) return true;
			if (value > 34028234663852886e22 || value < -34028234663852886e22) return `${value.toFixed()} out of range`;
			return true;
		case ScalarType.INT32:
		case ScalarType.SFIXED32:
		case ScalarType.SINT32:
			if (typeof value !== "number" || !Number.isInteger(value)) return false;
			if (value > 2147483647 || value < -2147483648) return `${value.toFixed()} out of range`;
			return true;
		case ScalarType.FIXED32:
		case ScalarType.UINT32:
			if (typeof value !== "number" || !Number.isInteger(value)) return false;
			if (value > 4294967295 || value < 0) return `${value.toFixed()} out of range`;
			return true;
		case ScalarType.BOOL: return typeof value == "boolean";
		case ScalarType.STRING:
			if (typeof value != "string") return false;
			return getTextEncoding().checkUtf8(value) || "invalid UTF8";
		case ScalarType.BYTES: return value instanceof Uint8Array;
		case ScalarType.INT64:
		case ScalarType.SFIXED64:
		case ScalarType.SINT64:
			if (typeof value == "bigint" || typeof value == "number" || typeof value == "string" && value.length > 0) try {
				protoInt64.parse(value);
				return true;
			} catch (_) {
				return `${value} out of range`;
			}
			return false;
		case ScalarType.FIXED64:
		case ScalarType.UINT64:
			if (typeof value == "bigint" || typeof value == "number" || typeof value == "string" && value.length > 0) try {
				protoInt64.uParse(value);
				return true;
			} catch (_) {
				return `${value} out of range`;
			}
			return false;
	}
}
function reasonSingular(field, val, details) {
	details = typeof details == "string" ? `: ${details}` : `, got ${formatVal(val)}`;
	if (field.scalar !== void 0) return `expected ${scalarTypeDescription(field.scalar)}` + details;
	if (field.enum !== void 0) return `expected ${field.enum.toString()}` + details;
	return `expected ${formatReflectMessage(field.message)}` + details;
}
function formatVal(val) {
	switch (typeof val) {
		case "object":
			if (val === null) return "null";
			if (val instanceof Uint8Array) return `Uint8Array(${val.length})`;
			if (Array.isArray(val)) return `Array(${val.length})`;
			if (isReflectList(val)) return formatReflectList(val.field());
			if (isReflectMap(val)) return formatReflectMap(val.field());
			if (isReflectMessage(val)) return formatReflectMessage(val.desc);
			if (isMessage(val)) return `message ${val.$typeName}`;
			return "object";
		case "string": return val.length > 30 ? "string" : `"${val.split("\"").join("\\\"")}"`;
		case "boolean": return String(val);
		case "number": return String(val);
		case "bigint": return String(val) + "n";
		default: return typeof val;
	}
}
function formatReflectMessage(desc) {
	return `ReflectMessage (${desc.typeName})`;
}
function formatReflectList(field) {
	switch (field.listKind) {
		case "message": return `ReflectList (${field.message.toString()})`;
		case "enum": return `ReflectList (${field.enum.toString()})`;
		case "scalar": return `ReflectList (${ScalarType[field.scalar]})`;
	}
}
function formatReflectMap(field) {
	switch (field.mapKind) {
		case "message": return `ReflectMap (${ScalarType[field.mapKey]}, ${field.message.toString()})`;
		case "enum": return `ReflectMap (${ScalarType[field.mapKey]}, ${field.enum.toString()})`;
		case "scalar": return `ReflectMap (${ScalarType[field.mapKey]}, ${ScalarType[field.scalar]})`;
	}
}
function scalarTypeDescription(scalar) {
	switch (scalar) {
		case ScalarType.STRING: return "string";
		case ScalarType.BOOL: return "boolean";
		case ScalarType.INT64:
		case ScalarType.SINT64:
		case ScalarType.SFIXED64: return "bigint (int64)";
		case ScalarType.UINT64:
		case ScalarType.FIXED64: return "bigint (uint64)";
		case ScalarType.BYTES: return "Uint8Array";
		case ScalarType.DOUBLE: return "number (float64)";
		case ScalarType.FLOAT: return "number (float32)";
		case ScalarType.FIXED32:
		case ScalarType.UINT32: return "number (uint32)";
		case ScalarType.INT32:
		case ScalarType.SFIXED32:
		case ScalarType.SINT32: return "number (int32)";
	}
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/reflect/reflect.js
/**
* Create a ReflectMessage.
*/
function reflect(messageDesc, message, check = true) {
	return new ReflectMessageImpl(messageDesc, message, check);
}
var messageSortedFields = /* @__PURE__ */ new WeakMap();
var ReflectMessageImpl = class {
	get sortedFields() {
		const cached = messageSortedFields.get(this.desc);
		if (cached) return cached;
		const sortedFields = this.desc.fields.concat().sort((a, b) => a.number - b.number);
		messageSortedFields.set(this.desc, sortedFields);
		return sortedFields;
	}
	constructor(messageDesc, message, check = true) {
		this.lists = /* @__PURE__ */ new Map();
		this.maps = /* @__PURE__ */ new Map();
		this.check = check;
		this.desc = messageDesc;
		this.message = this[unsafeLocal] = message !== null && message !== void 0 ? message : create(messageDesc);
		this.fields = messageDesc.fields;
		this.oneofs = messageDesc.oneofs;
		this.members = messageDesc.members;
	}
	findNumber(number) {
		if (!this._fieldsByNumber) this._fieldsByNumber = new Map(this.desc.fields.map((f) => [f.number, f]));
		return this._fieldsByNumber.get(number);
	}
	oneofCase(oneof) {
		assertOwn(this.message, oneof);
		return unsafeOneofCase(this.message, oneof);
	}
	isSet(field) {
		assertOwn(this.message, field);
		return unsafeIsSet(this.message, field);
	}
	clear(field) {
		assertOwn(this.message, field);
		unsafeClear(this.message, field);
	}
	get(field) {
		assertOwn(this.message, field);
		const value = unsafeGet(this.message, field);
		switch (field.fieldKind) {
			case "list":
				let list = this.lists.get(field);
				if (!list || list[unsafeLocal] !== value) this.lists.set(field, list = new ReflectListImpl(field, value, this.check));
				return list;
			case "map":
				let map = this.maps.get(field);
				if (!map || map[unsafeLocal] !== value) this.maps.set(field, map = new ReflectMapImpl(field, value, this.check));
				return map;
			case "message": return messageToReflect(field, value, this.check);
			case "scalar": return value === void 0 ? scalarZeroValue(field.scalar, false) : longToReflect(field, value);
			case "enum": return value !== null && value !== void 0 ? value : field.enum.values[0].number;
		}
	}
	set(field, value) {
		assertOwn(this.message, field);
		if (this.check) {
			const err = checkField(field, value);
			if (err) throw err;
		}
		let local;
		if (field.fieldKind == "message") local = messageToLocal(field, value);
		else if (isReflectMap(value) || isReflectList(value)) local = value[unsafeLocal];
		else local = longToLocal(field, value);
		unsafeSet(this.message, field, local);
	}
	getUnknown() {
		return this.message.$unknown;
	}
	setUnknown(value) {
		this.message.$unknown = value;
	}
};
function assertOwn(owner, member) {
	if (member.parent.typeName !== owner.$typeName) throw new FieldError(member, `cannot use ${member.toString()} with message ${owner.$typeName}`, "ForeignFieldError");
}
var ReflectListImpl = class {
	field() {
		return this._field;
	}
	get size() {
		return this._arr.length;
	}
	constructor(field, unsafeInput, check) {
		this._field = field;
		this._arr = this[unsafeLocal] = unsafeInput;
		this.check = check;
	}
	get(index) {
		const item = this._arr[index];
		return item === void 0 ? void 0 : listItemToReflect(this._field, item, this.check);
	}
	set(index, item) {
		if (index < 0 || index >= this._arr.length) throw new FieldError(this._field, `list item #${index + 1}: out of range`);
		if (this.check) {
			const err = checkListItem(this._field, index, item);
			if (err) throw err;
		}
		this._arr[index] = listItemToLocal(this._field, item);
	}
	add(item) {
		if (this.check) {
			const err = checkListItem(this._field, this._arr.length, item);
			if (err) throw err;
		}
		this._arr.push(listItemToLocal(this._field, item));
	}
	clear() {
		this._arr.splice(0, this._arr.length);
	}
	[Symbol.iterator]() {
		return this.values();
	}
	keys() {
		return this._arr.keys();
	}
	*values() {
		for (const item of this._arr) yield listItemToReflect(this._field, item, this.check);
	}
	*entries() {
		for (let i = 0; i < this._arr.length; i++) yield [i, listItemToReflect(this._field, this._arr[i], this.check)];
	}
};
var ReflectMapImpl = class {
	constructor(field, unsafeInput, check = true) {
		this.obj = this[unsafeLocal] = unsafeInput !== null && unsafeInput !== void 0 ? unsafeInput : {};
		this.check = check;
		this._field = field;
	}
	field() {
		return this._field;
	}
	set(key, value) {
		if (this.check) {
			const err = checkMapEntry(this._field, key, value);
			if (err) throw err;
		}
		this.obj[mapKeyToLocal(key)] = mapValueToLocal(this._field, value);
		return this;
	}
	delete(key) {
		const k = mapKeyToLocal(key);
		const has = Object.prototype.hasOwnProperty.call(this.obj, k);
		if (has) delete this.obj[k];
		return has;
	}
	clear() {
		for (const key of Object.keys(this.obj)) delete this.obj[key];
	}
	get(key) {
		let val = this.obj[mapKeyToLocal(key)];
		if (val !== void 0) val = mapValueToReflect(this._field, val, this.check);
		return val;
	}
	has(key) {
		return Object.prototype.hasOwnProperty.call(this.obj, mapKeyToLocal(key));
	}
	*keys() {
		for (const objKey of Object.keys(this.obj)) yield mapKeyToReflect(objKey, this._field.mapKey);
	}
	*entries() {
		for (const objEntry of Object.entries(this.obj)) yield [mapKeyToReflect(objEntry[0], this._field.mapKey), mapValueToReflect(this._field, objEntry[1], this.check)];
	}
	[Symbol.iterator]() {
		return this.entries();
	}
	get size() {
		return Object.keys(this.obj).length;
	}
	*values() {
		for (const val of Object.values(this.obj)) yield mapValueToReflect(this._field, val, this.check);
	}
	forEach(callbackfn, thisArg) {
		for (const mapEntry of this.entries()) callbackfn.call(thisArg, mapEntry[1], mapEntry[0], this);
	}
};
function messageToLocal(field, value) {
	if (!isReflectMessage(value)) return value;
	if (isWrapper(value.message) && !field.oneof && field.fieldKind == "message") return value.message.value;
	if (value.desc.typeName == "google.protobuf.Struct" && field.parent.typeName != "google.protobuf.Value") return wktStructToLocal(value.message);
	return value.message;
}
function messageToReflect(field, value, check) {
	if (value !== void 0) {
		if (isWrapperDesc(field.message) && !field.oneof && field.fieldKind == "message") value = {
			$typeName: field.message.typeName,
			value: longToReflect(field.message.fields[0], value)
		};
		else if (field.message.typeName == "google.protobuf.Struct" && field.parent.typeName != "google.protobuf.Value" && isObject(value)) value = wktStructToReflect(value);
	}
	return new ReflectMessageImpl(field.message, value, check);
}
function listItemToLocal(field, value) {
	if (field.listKind == "message") return messageToLocal(field, value);
	return longToLocal(field, value);
}
function listItemToReflect(field, value, check) {
	if (field.listKind == "message") return messageToReflect(field, value, check);
	return longToReflect(field, value);
}
function mapValueToLocal(field, value) {
	if (field.mapKind == "message") return messageToLocal(field, value);
	return longToLocal(field, value);
}
function mapValueToReflect(field, value, check) {
	if (field.mapKind == "message") return messageToReflect(field, value, check);
	return value;
}
function mapKeyToLocal(key) {
	return typeof key == "string" || typeof key == "number" ? key : String(key);
}
/**
* Converts a map key (any scalar value except float, double, or bytes) from its
* representation in a message (string or number, the only possible object key
* types) to the closest possible type in ECMAScript.
*/
function mapKeyToReflect(key, type) {
	switch (type) {
		case ScalarType.STRING: return key;
		case ScalarType.INT32:
		case ScalarType.FIXED32:
		case ScalarType.UINT32:
		case ScalarType.SFIXED32:
		case ScalarType.SINT32: {
			const n = Number.parseInt(key);
			if (Number.isFinite(n)) return n;
			break;
		}
		case ScalarType.BOOL:
			switch (key) {
				case "true": return true;
				case "false": return false;
			}
			break;
		case ScalarType.UINT64:
		case ScalarType.FIXED64:
			try {
				return protoInt64.uParse(key);
			} catch (_a) {}
			break;
		default:
			try {
				return protoInt64.parse(key);
			} catch (_b) {}
			break;
	}
	return key;
}
function longToReflect(field, value) {
	switch (field.scalar) {
		case ScalarType.INT64:
		case ScalarType.SFIXED64:
		case ScalarType.SINT64:
			if ("longAsString" in field && field.longAsString && typeof value == "string") value = protoInt64.parse(value);
			break;
		case ScalarType.FIXED64:
		case ScalarType.UINT64:
			if ("longAsString" in field && field.longAsString && typeof value == "string") value = protoInt64.uParse(value);
			break;
	}
	return value;
}
function longToLocal(field, value) {
	switch (field.scalar) {
		case ScalarType.INT64:
		case ScalarType.SFIXED64:
		case ScalarType.SINT64:
			if ("longAsString" in field && field.longAsString) value = String(value);
			else if (typeof value == "string" || typeof value == "number") value = protoInt64.parse(value);
			break;
		case ScalarType.FIXED64:
		case ScalarType.UINT64:
			if ("longAsString" in field && field.longAsString) value = String(value);
			else if (typeof value == "string" || typeof value == "number") value = protoInt64.uParse(value);
			break;
	}
	return value;
}
function wktStructToReflect(json) {
	const struct = {
		$typeName: "google.protobuf.Struct",
		fields: {}
	};
	if (isObject(json)) for (const [k, v] of Object.entries(json)) struct.fields[k] = wktValueToReflect(v);
	return struct;
}
function wktStructToLocal(val) {
	const json = {};
	for (const [k, v] of Object.entries(val.fields)) json[k] = wktValueToLocal(v);
	return json;
}
function wktValueToLocal(val) {
	switch (val.kind.case) {
		case "structValue": return wktStructToLocal(val.kind.value);
		case "listValue": return val.kind.value.values.map(wktValueToLocal);
		case "nullValue":
		case void 0: return null;
		default: return val.kind.value;
	}
}
function wktValueToReflect(json) {
	const value = {
		$typeName: "google.protobuf.Value",
		kind: { case: void 0 }
	};
	switch (typeof json) {
		case "number":
			value.kind = {
				case: "numberValue",
				value: json
			};
			break;
		case "string":
			value.kind = {
				case: "stringValue",
				value: json
			};
			break;
		case "boolean":
			value.kind = {
				case: "boolValue",
				value: json
			};
			break;
		case "object":
			if (json === null) value.kind = {
				case: "nullValue",
				value: 0
			};
			else if (Array.isArray(json)) {
				const listValue = {
					$typeName: "google.protobuf.ListValue",
					values: []
				};
				if (Array.isArray(json)) for (const e of json) listValue.values.push(wktValueToReflect(e));
				value.kind = {
					case: "listValue",
					value: listValue
				};
			} else value.kind = {
				case: "structValue",
				value: wktStructToReflect(json)
			};
			break;
	}
	return value;
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/wire/base64-encoding.js
/**
* Decodes a base64 string to a byte array.
*
* - ignores white-space, including line breaks and tabs
* - allows inner padding (can decode concatenated base64 strings)
* - does not require padding
* - understands base64url encoding:
*   "-" instead of "+",
*   "_" instead of "/",
*   no padding
*/
function base64Decode(base64Str) {
	const table = getDecodeTable();
	let es = base64Str.length * 3 / 4;
	if (base64Str[base64Str.length - 2] == "=") es -= 2;
	else if (base64Str[base64Str.length - 1] == "=") es -= 1;
	let bytes = new Uint8Array(es), bytePos = 0, groupPos = 0, b, p = 0;
	for (let i = 0; i < base64Str.length; i++) {
		b = table[base64Str.charCodeAt(i)];
		if (b === void 0) switch (base64Str[i]) {
			case "=": groupPos = 0;
			case "\n":
			case "\r":
			case "	":
			case " ": continue;
			default: throw Error("invalid base64 string");
		}
		switch (groupPos) {
			case 0:
				p = b;
				groupPos = 1;
				break;
			case 1:
				bytes[bytePos++] = p << 2 | (b & 48) >> 4;
				p = b;
				groupPos = 2;
				break;
			case 2:
				bytes[bytePos++] = (p & 15) << 4 | (b & 60) >> 2;
				p = b;
				groupPos = 3;
				break;
			case 3:
				bytes[bytePos++] = (p & 3) << 6 | b;
				groupPos = 0;
				break;
		}
	}
	if (groupPos == 1) throw Error("invalid base64 string");
	return bytes.subarray(0, bytePos);
}
/**
* Encode a byte array to a base64 string.
*
* By default, this function uses the standard base64 encoding with padding.
*
* To encode without padding, use encoding = "std_raw".
*
* To encode with the URL encoding, use encoding = "url", which replaces the
* characters +/ by their URL-safe counterparts -_, and omits padding.
*/
function base64Encode(bytes, encoding = "std") {
	const table = getEncodeTable(encoding);
	const pad = encoding == "std";
	let base64 = "", groupPos = 0, b, p = 0;
	for (let i = 0; i < bytes.length; i++) {
		b = bytes[i];
		switch (groupPos) {
			case 0:
				base64 += table[b >> 2];
				p = (b & 3) << 4;
				groupPos = 1;
				break;
			case 1:
				base64 += table[p | b >> 4];
				p = (b & 15) << 2;
				groupPos = 2;
				break;
			case 2:
				base64 += table[p | b >> 6];
				base64 += table[b & 63];
				groupPos = 0;
				break;
		}
	}
	if (groupPos) {
		base64 += table[p];
		if (pad) {
			base64 += "=";
			if (groupPos == 1) base64 += "=";
		}
	}
	return base64;
}
var encodeTableStd;
var encodeTableUrl;
var decodeTable;
function getEncodeTable(encoding) {
	if (!encodeTableStd) {
		encodeTableStd = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("");
		encodeTableUrl = encodeTableStd.slice(0, -2).concat("-", "_");
	}
	return encoding == "url" ? encodeTableUrl : encodeTableStd;
}
function getDecodeTable() {
	if (!decodeTable) {
		decodeTable = [];
		const encodeTable = getEncodeTable("std");
		for (let i = 0; i < encodeTable.length; i++) decodeTable[encodeTable[i].charCodeAt(0)] = i;
		decodeTable["-".charCodeAt(0)] = encodeTable.indexOf("+");
		decodeTable["_".charCodeAt(0)] = encodeTable.indexOf("/");
	}
	return decodeTable;
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/reflect/names.js
/**
* Converts snake_case to protoCamelCase according to the convention
* used by protoc to convert a field name to a JSON name.
*
* See https://protobuf.com/docs/language-spec#default-json-names
*
* The function protoSnakeCase provides the reverse.
*/
function protoCamelCase(snakeCase) {
	let capNext = false;
	const b = [];
	for (let i = 0; i < snakeCase.length; i++) {
		let c = snakeCase.charAt(i);
		switch (c) {
			case "_":
				capNext = true;
				break;
			case "0":
			case "1":
			case "2":
			case "3":
			case "4":
			case "5":
			case "6":
			case "7":
			case "8":
			case "9":
				b.push(c);
				capNext = false;
				break;
			default:
				if (capNext) {
					capNext = false;
					c = c.toUpperCase();
				}
				b.push(c);
				break;
		}
	}
	return b.join("");
}
/**
* Converts protoCamelCase to snake_case.
*
* This function is the reverse of function protoCamelCase. Note that some names
* are not reversible - for example, "foo__bar" -> "fooBar" -> "foo_bar".
*/
function protoSnakeCase(lowerCamelCase) {
	return lowerCamelCase.replace(/[A-Z]/g, (letter) => "_" + letter.toLowerCase());
}
/**
* Names that cannot be used for object properties because they are reserved
* by built-in JavaScript properties.
*/
var reservedObjectProperties = new Set([
	"constructor",
	"toString",
	"toJSON",
	"valueOf"
]);
/**
* Escapes names that are reserved for ECMAScript built-in object properties.
*
* Also see safeIdentifier() from @bufbuild/protoplugin.
*/
function safeObjectProperty(name) {
	return reservedObjectProperties.has(name) ? name + "$" : name;
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/codegenv2/restore-json-names.js
/**
* @private
*/
function restoreJsonNames(message) {
	for (const f of message.field) if (!unsafeIsSetExplicit(f, "jsonName")) f.jsonName = protoCamelCase(f.name);
	message.nestedType.forEach(restoreJsonNames);
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/wire/text-format.js
/**
* Parse an enum value from the Protobuf text format.
*
* @private
*/
function parseTextFormatEnumValue(descEnum, value) {
	const enumValue = descEnum.values.find((v) => v.name === value);
	if (!enumValue) throw new Error(`cannot parse ${descEnum} default value: ${value}`);
	return enumValue.number;
}
/**
* Parse a scalar value from the Protobuf text format.
*
* @private
*/
function parseTextFormatScalarValue(type, value) {
	switch (type) {
		case ScalarType.STRING: return value;
		case ScalarType.BYTES: {
			const u = unescapeBytesDefaultValue(value);
			if (u === false) throw new Error(`cannot parse ${ScalarType[type]} default value: ${value}`);
			return u;
		}
		case ScalarType.INT64:
		case ScalarType.SFIXED64:
		case ScalarType.SINT64: return protoInt64.parse(value);
		case ScalarType.UINT64:
		case ScalarType.FIXED64: return protoInt64.uParse(value);
		case ScalarType.DOUBLE:
		case ScalarType.FLOAT: switch (value) {
			case "inf": return Number.POSITIVE_INFINITY;
			case "-inf": return Number.NEGATIVE_INFINITY;
			case "nan": return NaN;
			default: return parseFloat(value);
		}
		case ScalarType.BOOL: return value === "true";
		case ScalarType.INT32:
		case ScalarType.UINT32:
		case ScalarType.SINT32:
		case ScalarType.FIXED32:
		case ScalarType.SFIXED32: return parseInt(value, 10);
	}
}
/**
* Parses a text-encoded default value (proto2) of a BYTES field.
*/
function unescapeBytesDefaultValue(str) {
	const b = [];
	const input = {
		tail: str,
		c: "",
		next() {
			if (this.tail.length == 0) return false;
			this.c = this.tail[0];
			this.tail = this.tail.substring(1);
			return true;
		},
		take(n) {
			if (this.tail.length >= n) {
				const r = this.tail.substring(0, n);
				this.tail = this.tail.substring(n);
				return r;
			}
			return false;
		}
	};
	while (input.next()) switch (input.c) {
		case "\\":
			if (input.next()) switch (input.c) {
				case "\\":
					b.push(input.c.charCodeAt(0));
					break;
				case "b":
					b.push(8);
					break;
				case "f":
					b.push(12);
					break;
				case "n":
					b.push(10);
					break;
				case "r":
					b.push(13);
					break;
				case "t":
					b.push(9);
					break;
				case "v":
					b.push(11);
					break;
				case "0":
				case "1":
				case "2":
				case "3":
				case "4":
				case "5":
				case "6":
				case "7": {
					const s = input.c;
					const t = input.take(2);
					if (t === false) return false;
					const n = parseInt(s + t, 8);
					if (Number.isNaN(n)) return false;
					b.push(n);
					break;
				}
				case "x": {
					const s = input.c;
					const t = input.take(2);
					if (t === false) return false;
					const n = parseInt(s + t, 16);
					if (Number.isNaN(n)) return false;
					b.push(n);
					break;
				}
				case "u": {
					const s = input.c;
					const t = input.take(4);
					if (t === false) return false;
					const n = parseInt(s + t, 16);
					if (Number.isNaN(n)) return false;
					const chunk = new Uint8Array(4);
					new DataView(chunk.buffer).setInt32(0, n, true);
					b.push(chunk[0], chunk[1], chunk[2], chunk[3]);
					break;
				}
				case "U": {
					const s = input.c;
					const t = input.take(8);
					if (t === false) return false;
					const tc = protoInt64.uEnc(s + t);
					const chunk = new Uint8Array(8);
					const view = new DataView(chunk.buffer);
					view.setInt32(0, tc.lo, true);
					view.setInt32(4, tc.hi, true);
					b.push(chunk[0], chunk[1], chunk[2], chunk[3], chunk[4], chunk[5], chunk[6], chunk[7]);
					break;
				}
			}
			break;
		default: b.push(input.c.charCodeAt(0));
	}
	return new Uint8Array(b);
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/reflect/nested-types.js
/**
* Iterate over all types - enumerations, extensions, services, messages -
* and enumerations, extensions and messages nested in messages.
*/
function* nestedTypes(desc) {
	switch (desc.kind) {
		case "file":
			for (const message of desc.messages) {
				yield message;
				yield* nestedTypes(message);
			}
			yield* desc.enums;
			yield* desc.services;
			yield* desc.extensions;
			break;
		case "message":
			for (const message of desc.nestedMessages) {
				yield message;
				yield* nestedTypes(message);
			}
			yield* desc.nestedEnums;
			yield* desc.nestedExtensions;
			break;
	}
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/registry.js
function createFileRegistry(...args) {
	const registry = createBaseRegistry();
	if (!args.length) return registry;
	if ("$typeName" in args[0] && args[0].$typeName == "google.protobuf.FileDescriptorSet") {
		for (const file of args[0].file) addFile(file, registry);
		return registry;
	}
	if ("$typeName" in args[0]) {
		const input = args[0];
		const resolve = args[1];
		const seen = /* @__PURE__ */ new Set();
		function recurseDeps(file) {
			const deps = [];
			for (const protoFileName of file.dependency) {
				if (registry.getFile(protoFileName) != void 0) continue;
				if (seen.has(protoFileName)) continue;
				const dep = resolve(protoFileName);
				if (!dep) throw new Error(`Unable to resolve ${protoFileName}, imported by ${file.name}`);
				if ("kind" in dep) registry.addFile(dep, false, true);
				else {
					seen.add(dep.name);
					deps.push(dep);
				}
			}
			return deps.concat(...deps.map(recurseDeps));
		}
		for (const file of [input, ...recurseDeps(input)].reverse()) addFile(file, registry);
	} else for (const fileReg of args) for (const file of fileReg.files) registry.addFile(file);
	return registry;
}
/**
* @private
*/
function createBaseRegistry() {
	const types = /* @__PURE__ */ new Map();
	const extendees = /* @__PURE__ */ new Map();
	const files = /* @__PURE__ */ new Map();
	return {
		kind: "registry",
		types,
		extendees,
		[Symbol.iterator]() {
			return types.values();
		},
		get files() {
			return files.values();
		},
		addFile(file, skipTypes, withDeps) {
			files.set(file.proto.name, file);
			if (!skipTypes) for (const type of nestedTypes(file)) this.add(type);
			if (withDeps) for (const f of file.dependencies) this.addFile(f, skipTypes, withDeps);
		},
		add(desc) {
			if (desc.kind == "extension") {
				let numberToExt = extendees.get(desc.extendee.typeName);
				if (!numberToExt) extendees.set(desc.extendee.typeName, numberToExt = /* @__PURE__ */ new Map());
				numberToExt.set(desc.number, desc);
			}
			types.set(desc.typeName, desc);
		},
		get(typeName) {
			return types.get(typeName);
		},
		getFile(fileName) {
			return files.get(fileName);
		},
		getMessage(typeName) {
			const t = types.get(typeName);
			return (t === null || t === void 0 ? void 0 : t.kind) == "message" ? t : void 0;
		},
		getEnum(typeName) {
			const t = types.get(typeName);
			return (t === null || t === void 0 ? void 0 : t.kind) == "enum" ? t : void 0;
		},
		getExtension(typeName) {
			const t = types.get(typeName);
			return (t === null || t === void 0 ? void 0 : t.kind) == "extension" ? t : void 0;
		},
		getExtensionFor(extendee, no) {
			var _a;
			return (_a = extendees.get(extendee.typeName)) === null || _a === void 0 ? void 0 : _a.get(no);
		},
		getService(typeName) {
			const t = types.get(typeName);
			return (t === null || t === void 0 ? void 0 : t.kind) == "service" ? t : void 0;
		}
	};
}
var EDITION_PROTO2 = 998;
var EDITION_PROTO3 = 999;
var TYPE_STRING = 9;
var TYPE_GROUP = 10;
var TYPE_MESSAGE = 11;
var TYPE_BYTES = 12;
var TYPE_ENUM = 14;
var LABEL_REPEATED = 3;
var LABEL_REQUIRED = 2;
var JS_STRING = 1;
var IDEMPOTENCY_UNKNOWN = 0;
var EXPLICIT = 1;
var IMPLICIT = 2;
var LEGACY_REQUIRED = 3;
var PACKED = 1;
var DELIMITED = 2;
var OPEN = 1;
var featureDefaults = {
	998: {
		fieldPresence: 1,
		enumType: 2,
		repeatedFieldEncoding: 2,
		utf8Validation: 3,
		messageEncoding: 1,
		jsonFormat: 2,
		enforceNamingStyle: 2,
		defaultSymbolVisibility: 1
	},
	999: {
		fieldPresence: 2,
		enumType: 1,
		repeatedFieldEncoding: 1,
		utf8Validation: 2,
		messageEncoding: 1,
		jsonFormat: 1,
		enforceNamingStyle: 2,
		defaultSymbolVisibility: 1
	},
	1e3: {
		fieldPresence: 1,
		enumType: 1,
		repeatedFieldEncoding: 1,
		utf8Validation: 2,
		messageEncoding: 1,
		jsonFormat: 1,
		enforceNamingStyle: 2,
		defaultSymbolVisibility: 1
	},
	1001: {
		fieldPresence: 1,
		enumType: 1,
		repeatedFieldEncoding: 1,
		utf8Validation: 2,
		messageEncoding: 1,
		jsonFormat: 1,
		enforceNamingStyle: 1,
		defaultSymbolVisibility: 2
	}
};
/**
* Create a descriptor for a file, add it to the registry.
*/
function addFile(proto, reg) {
	var _a, _b;
	const file = {
		kind: "file",
		proto,
		deprecated: (_b = (_a = proto.options) === null || _a === void 0 ? void 0 : _a.deprecated) !== null && _b !== void 0 ? _b : false,
		edition: getFileEdition(proto),
		name: proto.name.replace(/\.proto$/, ""),
		dependencies: findFileDependencies(proto, reg),
		enums: [],
		messages: [],
		extensions: [],
		services: [],
		toString() {
			return `file ${proto.name}`;
		}
	};
	const mapEntriesStore = /* @__PURE__ */ new Map();
	const mapEntries = {
		get(typeName) {
			return mapEntriesStore.get(typeName);
		},
		add(desc) {
			var _a;
			assert(((_a = desc.proto.options) === null || _a === void 0 ? void 0 : _a.mapEntry) === true);
			mapEntriesStore.set(desc.typeName, desc);
		}
	};
	for (const enumProto of proto.enumType) addEnum(enumProto, file, void 0, reg);
	for (const messageProto of proto.messageType) addMessage(messageProto, file, void 0, reg, mapEntries);
	for (const serviceProto of proto.service) addService(serviceProto, file, reg);
	addExtensions(file, reg);
	for (const mapEntry of mapEntriesStore.values()) addFields(mapEntry, reg, mapEntries);
	for (const message of file.messages) {
		addFields(message, reg, mapEntries);
		addExtensions(message, reg);
	}
	reg.addFile(file, true);
}
/**
* Create descriptors for extensions, and add them to the message / file,
* and to our cart.
* Recurses into nested types.
*/
function addExtensions(desc, reg) {
	switch (desc.kind) {
		case "file":
			for (const proto of desc.proto.extension) {
				const ext = newField(proto, desc, reg);
				desc.extensions.push(ext);
				reg.add(ext);
			}
			break;
		case "message":
			for (const proto of desc.proto.extension) {
				const ext = newField(proto, desc, reg);
				desc.nestedExtensions.push(ext);
				reg.add(ext);
			}
			for (const message of desc.nestedMessages) addExtensions(message, reg);
			break;
	}
}
/**
* Create descriptors for fields and oneof groups, and add them to the message.
* Recurses into nested types.
*/
function addFields(message, reg, mapEntries) {
	const allOneofs = message.proto.oneofDecl.map((proto) => newOneof(proto, message));
	const oneofsSeen = /* @__PURE__ */ new Set();
	for (const proto of message.proto.field) {
		const oneof = findOneof(proto, allOneofs);
		const field = newField(proto, message, reg, oneof, mapEntries);
		message.fields.push(field);
		message.field[field.localName] = field;
		if (oneof === void 0) message.members.push(field);
		else {
			oneof.fields.push(field);
			if (!oneofsSeen.has(oneof)) {
				oneofsSeen.add(oneof);
				message.members.push(oneof);
			}
		}
	}
	for (const oneof of allOneofs.filter((o) => oneofsSeen.has(o))) message.oneofs.push(oneof);
	for (const child of message.nestedMessages) addFields(child, reg, mapEntries);
}
/**
* Create a descriptor for an enumeration, and add it our cart and to the
* parent type, if any.
*/
function addEnum(proto, file, parent, reg) {
	var _a, _b, _c, _d, _e;
	const sharedPrefix = findEnumSharedPrefix(proto.name, proto.value);
	const desc = {
		kind: "enum",
		proto,
		deprecated: (_b = (_a = proto.options) === null || _a === void 0 ? void 0 : _a.deprecated) !== null && _b !== void 0 ? _b : false,
		file,
		parent,
		open: true,
		name: proto.name,
		typeName: makeTypeName(proto, parent, file),
		value: {},
		values: [],
		sharedPrefix,
		toString() {
			return `enum ${this.typeName}`;
		}
	};
	desc.open = isEnumOpen(desc);
	reg.add(desc);
	for (const p of proto.value) {
		const name = p.name;
		desc.values.push(desc.value[p.number] = {
			kind: "enum_value",
			proto: p,
			deprecated: (_d = (_c = p.options) === null || _c === void 0 ? void 0 : _c.deprecated) !== null && _d !== void 0 ? _d : false,
			parent: desc,
			name,
			localName: safeObjectProperty(sharedPrefix == void 0 ? name : name.substring(sharedPrefix.length)),
			number: p.number,
			toString() {
				return `enum value ${desc.typeName}.${name}`;
			}
		});
	}
	((_e = parent === null || parent === void 0 ? void 0 : parent.nestedEnums) !== null && _e !== void 0 ? _e : file.enums).push(desc);
}
/**
* Create a descriptor for a message, including nested types, and add it to our
* cart. Note that this does not create descriptors fields.
*/
function addMessage(proto, file, parent, reg, mapEntries) {
	var _a, _b, _c, _d;
	const desc = {
		kind: "message",
		proto,
		deprecated: (_b = (_a = proto.options) === null || _a === void 0 ? void 0 : _a.deprecated) !== null && _b !== void 0 ? _b : false,
		file,
		parent,
		name: proto.name,
		typeName: makeTypeName(proto, parent, file),
		fields: [],
		field: {},
		oneofs: [],
		members: [],
		nestedEnums: [],
		nestedMessages: [],
		nestedExtensions: [],
		toString() {
			return `message ${this.typeName}`;
		}
	};
	if (((_c = proto.options) === null || _c === void 0 ? void 0 : _c.mapEntry) === true) mapEntries.add(desc);
	else {
		((_d = parent === null || parent === void 0 ? void 0 : parent.nestedMessages) !== null && _d !== void 0 ? _d : file.messages).push(desc);
		reg.add(desc);
	}
	for (const enumProto of proto.enumType) addEnum(enumProto, file, desc, reg);
	for (const messageProto of proto.nestedType) addMessage(messageProto, file, desc, reg, mapEntries);
}
/**
* Create a descriptor for a service, including methods, and add it to our
* cart.
*/
function addService(proto, file, reg) {
	var _a, _b;
	const desc = {
		kind: "service",
		proto,
		deprecated: (_b = (_a = proto.options) === null || _a === void 0 ? void 0 : _a.deprecated) !== null && _b !== void 0 ? _b : false,
		file,
		name: proto.name,
		typeName: makeTypeName(proto, void 0, file),
		methods: [],
		method: {},
		toString() {
			return `service ${this.typeName}`;
		}
	};
	file.services.push(desc);
	reg.add(desc);
	for (const methodProto of proto.method) {
		const method = newMethod(methodProto, desc, reg);
		desc.methods.push(method);
		desc.method[method.localName] = method;
	}
}
/**
* Create a descriptor for a method.
*/
function newMethod(proto, parent, reg) {
	var _a, _b, _c, _d;
	let methodKind;
	if (proto.clientStreaming && proto.serverStreaming) methodKind = "bidi_streaming";
	else if (proto.clientStreaming) methodKind = "client_streaming";
	else if (proto.serverStreaming) methodKind = "server_streaming";
	else methodKind = "unary";
	const input = reg.getMessage(trimLeadingDot(proto.inputType));
	const output = reg.getMessage(trimLeadingDot(proto.outputType));
	assert(input, `invalid MethodDescriptorProto: input_type ${proto.inputType} not found`);
	assert(output, `invalid MethodDescriptorProto: output_type ${proto.inputType} not found`);
	const name = proto.name;
	return {
		kind: "rpc",
		proto,
		deprecated: (_b = (_a = proto.options) === null || _a === void 0 ? void 0 : _a.deprecated) !== null && _b !== void 0 ? _b : false,
		parent,
		name,
		localName: safeObjectProperty(name.length ? safeObjectProperty(name[0].toLowerCase() + name.substring(1)) : name),
		methodKind,
		input,
		output,
		idempotency: (_d = (_c = proto.options) === null || _c === void 0 ? void 0 : _c.idempotencyLevel) !== null && _d !== void 0 ? _d : IDEMPOTENCY_UNKNOWN,
		toString() {
			return `rpc ${parent.typeName}.${name}`;
		}
	};
}
/**
* Create a descriptor for a oneof group.
*/
function newOneof(proto, parent) {
	return {
		kind: "oneof",
		proto,
		deprecated: false,
		parent,
		fields: [],
		name: proto.name,
		localName: safeObjectProperty(protoCamelCase(proto.name)),
		toString() {
			return `oneof ${parent.typeName}.${this.name}`;
		}
	};
}
function newField(proto, parentOrFile, reg, oneof, mapEntries) {
	var _a, _b, _c;
	const isExtension = mapEntries === void 0;
	const field = {
		kind: "field",
		proto,
		deprecated: (_b = (_a = proto.options) === null || _a === void 0 ? void 0 : _a.deprecated) !== null && _b !== void 0 ? _b : false,
		name: proto.name,
		number: proto.number,
		scalar: void 0,
		message: void 0,
		enum: void 0,
		presence: getFieldPresence(proto, oneof, isExtension, parentOrFile),
		listKind: void 0,
		mapKind: void 0,
		mapKey: void 0,
		delimitedEncoding: void 0,
		packed: void 0,
		longAsString: false,
		getDefaultValue: void 0
	};
	if (isExtension) {
		const file = parentOrFile.kind == "file" ? parentOrFile : parentOrFile.file;
		const parent = parentOrFile.kind == "file" ? void 0 : parentOrFile;
		const typeName = makeTypeName(proto, parent, file);
		field.kind = "extension";
		field.file = file;
		field.parent = parent;
		field.oneof = void 0;
		field.typeName = typeName;
		field.jsonName = `[${typeName}]`;
		field.toString = () => `extension ${typeName}`;
		const extendee = reg.getMessage(trimLeadingDot(proto.extendee));
		assert(extendee, `invalid FieldDescriptorProto: extendee ${proto.extendee} not found`);
		field.extendee = extendee;
	} else {
		const parent = parentOrFile;
		assert(parent.kind == "message");
		field.parent = parent;
		field.oneof = oneof;
		field.localName = oneof ? protoCamelCase(proto.name) : safeObjectProperty(protoCamelCase(proto.name));
		field.jsonName = proto.jsonName;
		field.toString = () => `field ${parent.typeName}.${proto.name}`;
	}
	const label = proto.label;
	const type = proto.type;
	const jstype = (_c = proto.options) === null || _c === void 0 ? void 0 : _c.jstype;
	if (label === LABEL_REPEATED) {
		const mapEntry = type == TYPE_MESSAGE ? mapEntries === null || mapEntries === void 0 ? void 0 : mapEntries.get(trimLeadingDot(proto.typeName)) : void 0;
		if (mapEntry) {
			field.fieldKind = "map";
			const { key, value } = findMapEntryFields(mapEntry);
			field.mapKey = key.scalar;
			field.mapKind = value.fieldKind;
			field.message = value.message;
			field.delimitedEncoding = false;
			field.enum = value.enum;
			field.scalar = value.scalar;
			return field;
		}
		field.fieldKind = "list";
		switch (type) {
			case TYPE_MESSAGE:
			case TYPE_GROUP:
				field.listKind = "message";
				field.message = reg.getMessage(trimLeadingDot(proto.typeName));
				assert(field.message);
				field.delimitedEncoding = isDelimitedEncoding(proto, parentOrFile);
				break;
			case TYPE_ENUM:
				field.listKind = "enum";
				field.enum = reg.getEnum(trimLeadingDot(proto.typeName));
				assert(field.enum);
				break;
			default:
				field.listKind = "scalar";
				field.scalar = type;
				field.longAsString = jstype == JS_STRING;
				break;
		}
		field.packed = isPackedField(proto, parentOrFile);
		return field;
	}
	switch (type) {
		case TYPE_MESSAGE:
		case TYPE_GROUP:
			field.fieldKind = "message";
			field.message = reg.getMessage(trimLeadingDot(proto.typeName));
			assert(field.message, `invalid FieldDescriptorProto: type_name ${proto.typeName} not found`);
			field.delimitedEncoding = isDelimitedEncoding(proto, parentOrFile);
			field.getDefaultValue = () => void 0;
			break;
		case TYPE_ENUM: {
			const enumeration = reg.getEnum(trimLeadingDot(proto.typeName));
			assert(enumeration !== void 0, `invalid FieldDescriptorProto: type_name ${proto.typeName} not found`);
			field.fieldKind = "enum";
			field.enum = reg.getEnum(trimLeadingDot(proto.typeName));
			field.getDefaultValue = () => {
				return unsafeIsSetExplicit(proto, "defaultValue") ? parseTextFormatEnumValue(enumeration, proto.defaultValue) : void 0;
			};
			break;
		}
		default:
			field.fieldKind = "scalar";
			field.scalar = type;
			field.longAsString = jstype == JS_STRING;
			field.getDefaultValue = () => {
				return unsafeIsSetExplicit(proto, "defaultValue") ? parseTextFormatScalarValue(type, proto.defaultValue) : void 0;
			};
			break;
	}
	return field;
}
/**
* Parse the "syntax" and "edition" fields, returning one of the supported
* editions.
*/
function getFileEdition(proto) {
	switch (proto.syntax) {
		case "":
		case "proto2": return EDITION_PROTO2;
		case "proto3": return EDITION_PROTO3;
		case "editions":
			if (proto.edition in featureDefaults) return proto.edition;
			throw new Error(`${proto.name}: unsupported edition`);
		default: throw new Error(`${proto.name}: unsupported syntax "${proto.syntax}"`);
	}
}
/**
* Resolve dependencies of FileDescriptorProto to DescFile.
*/
function findFileDependencies(proto, reg) {
	return proto.dependency.map((wantName) => {
		const dep = reg.getFile(wantName);
		if (!dep) throw new Error(`Cannot find ${wantName}, imported by ${proto.name}`);
		return dep;
	});
}
/**
* Finds a prefix shared by enum values, for example `my_enum_` for
* `enum MyEnum {MY_ENUM_A=0; MY_ENUM_B=1;}`.
*/
function findEnumSharedPrefix(enumName, values) {
	const prefix = camelToSnakeCase(enumName) + "_";
	for (const value of values) {
		if (!value.name.toLowerCase().startsWith(prefix)) return;
		const shortName = value.name.substring(prefix.length);
		if (shortName.length == 0) return;
		if (/^\d/.test(shortName)) return;
	}
	return prefix;
}
/**
* Converts lowerCamelCase or UpperCamelCase into lower_snake_case.
* This is used to find shared prefixes in an enum.
*/
function camelToSnakeCase(camel) {
	return (camel.substring(0, 1) + camel.substring(1).replace(/[A-Z]/g, (c) => "_" + c)).toLowerCase();
}
/**
* Create a fully qualified name for a protobuf type or extension field.
*
* The fully qualified name for messages, enumerations, and services is
* constructed by concatenating the package name (if present), parent
* message names (for nested types), and the type name. We omit the leading
* dot added by protobuf compilers. Examples:
* - mypackage.MyMessage
* - mypackage.MyMessage.NestedMessage
*
* The fully qualified name for extension fields is constructed by
* concatenating the package name (if present), parent message names (for
* extensions declared within a message), and the field name. Examples:
* - mypackage.extfield
* - mypackage.MyMessage.extfield
*/
function makeTypeName(proto, parent, file) {
	let typeName;
	if (parent) typeName = `${parent.typeName}.${proto.name}`;
	else if (file.proto.package.length > 0) typeName = `${file.proto.package}.${proto.name}`;
	else typeName = `${proto.name}`;
	return typeName;
}
/**
* Remove the leading dot from a fully qualified type name.
*/
function trimLeadingDot(typeName) {
	return typeName.startsWith(".") ? typeName.substring(1) : typeName;
}
/**
* Did the user put the field in a oneof group?
* Synthetic oneofs for proto3 optionals are ignored.
*/
function findOneof(proto, allOneofs) {
	if (!unsafeIsSetExplicit(proto, "oneofIndex")) return;
	if (proto.proto3Optional) return;
	const oneof = allOneofs[proto.oneofIndex];
	assert(oneof, `invalid FieldDescriptorProto: oneof #${proto.oneofIndex} for field #${proto.number} not found`);
	return oneof;
}
/**
* Presence of the field.
* See https://protobuf.dev/programming-guides/field_presence/
*/
function getFieldPresence(proto, oneof, isExtension, parent) {
	if (proto.label == LABEL_REQUIRED) return LEGACY_REQUIRED;
	if (proto.label == LABEL_REPEATED) return IMPLICIT;
	if (!!oneof || proto.proto3Optional) return EXPLICIT;
	if (isExtension) return EXPLICIT;
	const resolved = resolveFeature("fieldPresence", {
		proto,
		parent
	});
	if (resolved == IMPLICIT && (proto.type == TYPE_MESSAGE || proto.type == TYPE_GROUP)) return EXPLICIT;
	return resolved;
}
/**
* Pack this repeated field?
*/
function isPackedField(proto, parent) {
	if (proto.label != LABEL_REPEATED) return false;
	switch (proto.type) {
		case TYPE_STRING:
		case TYPE_BYTES:
		case TYPE_GROUP:
		case TYPE_MESSAGE: return false;
	}
	const o = proto.options;
	if (o && unsafeIsSetExplicit(o, "packed")) return o.packed;
	return PACKED == resolveFeature("repeatedFieldEncoding", {
		proto,
		parent
	});
}
/**
* Find the key and value fields of a synthetic map entry message.
*/
function findMapEntryFields(mapEntry) {
	const key = mapEntry.fields.find((f) => f.number === 1);
	const value = mapEntry.fields.find((f) => f.number === 2);
	assert(key && key.fieldKind == "scalar" && key.scalar != ScalarType.BYTES && key.scalar != ScalarType.FLOAT && key.scalar != ScalarType.DOUBLE && value && value.fieldKind != "list" && value.fieldKind != "map");
	return {
		key,
		value
	};
}
/**
* Enumerations can be open or closed.
* See https://protobuf.dev/programming-guides/enum/
*/
function isEnumOpen(desc) {
	var _a;
	return OPEN == resolveFeature("enumType", {
		proto: desc.proto,
		parent: (_a = desc.parent) !== null && _a !== void 0 ? _a : desc.file
	});
}
/**
* Encode the message delimited (a.k.a. proto2 group encoding), or
* length-prefixed?
*/
function isDelimitedEncoding(proto, parent) {
	if (proto.type == TYPE_GROUP) return true;
	return DELIMITED == resolveFeature("messageEncoding", {
		proto,
		parent
	});
}
function resolveFeature(name, ref) {
	var _a, _b;
	const featureSet = (_a = ref.proto.options) === null || _a === void 0 ? void 0 : _a.features;
	if (featureSet) {
		const val = featureSet[name];
		if (val != 0) return val;
	}
	if ("kind" in ref) {
		if (ref.kind == "message") return resolveFeature(name, (_b = ref.parent) !== null && _b !== void 0 ? _b : ref.file);
		const editionDefaults = featureDefaults[ref.edition];
		if (!editionDefaults) throw new Error(`feature default for edition ${ref.edition} not found`);
		return editionDefaults[name];
	}
	return resolveFeature(name, ref.parent);
}
/**
* Assert that condition is truthy or throw error (with message)
*/
function assert(condition, msg) {
	if (!condition) throw new Error(msg);
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/codegenv2/boot.js
/**
* Hydrate a file descriptor for google/protobuf/descriptor.proto from a plain
* object.
*
* See createFileDescriptorProtoBoot() for details.
*
* @private
*/
function boot(boot) {
	const root = bootFileDescriptorProto(boot);
	root.messageType.forEach(restoreJsonNames);
	return createFileRegistry(root, () => void 0).getFile(root.name);
}
/**
* Creates the message google.protobuf.FileDescriptorProto from an object literal.
*
* See createFileDescriptorProtoBoot() for details.
*
* @private
*/
function bootFileDescriptorProto(init) {
	return Object.assign(Object.create({
		syntax: "",
		edition: 0
	}), Object.assign(Object.assign({
		$typeName: "google.protobuf.FileDescriptorProto",
		dependency: [],
		publicDependency: [],
		weakDependency: [],
		optionDependency: [],
		service: [],
		extension: []
	}, init), {
		messageType: init.messageType.map(bootDescriptorProto),
		enumType: init.enumType.map(bootEnumDescriptorProto)
	}));
}
function bootDescriptorProto(init) {
	var _a, _b, _c, _d, _e, _f, _g, _h;
	return Object.assign(Object.create({ visibility: 0 }), {
		$typeName: "google.protobuf.DescriptorProto",
		name: init.name,
		field: (_b = (_a = init.field) === null || _a === void 0 ? void 0 : _a.map(bootFieldDescriptorProto)) !== null && _b !== void 0 ? _b : [],
		extension: [],
		nestedType: (_d = (_c = init.nestedType) === null || _c === void 0 ? void 0 : _c.map(bootDescriptorProto)) !== null && _d !== void 0 ? _d : [],
		enumType: (_f = (_e = init.enumType) === null || _e === void 0 ? void 0 : _e.map(bootEnumDescriptorProto)) !== null && _f !== void 0 ? _f : [],
		extensionRange: (_h = (_g = init.extensionRange) === null || _g === void 0 ? void 0 : _g.map((e) => Object.assign({ $typeName: "google.protobuf.DescriptorProto.ExtensionRange" }, e))) !== null && _h !== void 0 ? _h : [],
		oneofDecl: [],
		reservedRange: [],
		reservedName: []
	});
}
function bootFieldDescriptorProto(init) {
	return Object.assign(Object.create({
		label: 1,
		typeName: "",
		extendee: "",
		defaultValue: "",
		oneofIndex: 0,
		jsonName: "",
		proto3Optional: false
	}), Object.assign(Object.assign({ $typeName: "google.protobuf.FieldDescriptorProto" }, init), { options: init.options ? bootFieldOptions(init.options) : void 0 }));
}
function bootFieldOptions(init) {
	var _a, _b, _c;
	return Object.assign(Object.create({
		ctype: 0,
		packed: false,
		jstype: 0,
		lazy: false,
		unverifiedLazy: false,
		deprecated: false,
		weak: false,
		debugRedact: false,
		retention: 0
	}), Object.assign(Object.assign({ $typeName: "google.protobuf.FieldOptions" }, init), {
		targets: (_a = init.targets) !== null && _a !== void 0 ? _a : [],
		editionDefaults: (_c = (_b = init.editionDefaults) === null || _b === void 0 ? void 0 : _b.map((e) => Object.assign({ $typeName: "google.protobuf.FieldOptions.EditionDefault" }, e))) !== null && _c !== void 0 ? _c : [],
		uninterpretedOption: []
	}));
}
function bootEnumDescriptorProto(init) {
	return Object.assign(Object.create({ visibility: 0 }), {
		$typeName: "google.protobuf.EnumDescriptorProto",
		name: init.name,
		reservedName: [],
		reservedRange: [],
		value: init.value.map((e) => Object.assign({ $typeName: "google.protobuf.EnumValueDescriptorProto" }, e))
	});
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/codegenv2/message.js
/**
* Hydrate a message descriptor.
*
* @private
*/
function messageDesc(file, path, ...paths) {
	return paths.reduce((acc, cur) => acc.nestedMessages[cur], file.messages[path]);
}
/**
* Describes the message google.protobuf.FileDescriptorProto.
* Use `create(FileDescriptorProtoSchema)` to create a new message.
*/
var FileDescriptorProtoSchema = /*@__PURE__*/ messageDesc(/* @__PURE__ */ boot({
	"name": "google/protobuf/descriptor.proto",
	"package": "google.protobuf",
	"messageType": [
		{
			"name": "FileDescriptorSet",
			"field": [{
				"name": "file",
				"number": 1,
				"type": 11,
				"label": 3,
				"typeName": ".google.protobuf.FileDescriptorProto"
			}],
			"extensionRange": [{
				"start": 536e6,
				"end": 536000001
			}]
		},
		{
			"name": "FileDescriptorProto",
			"field": [
				{
					"name": "name",
					"number": 1,
					"type": 9,
					"label": 1
				},
				{
					"name": "package",
					"number": 2,
					"type": 9,
					"label": 1
				},
				{
					"name": "dependency",
					"number": 3,
					"type": 9,
					"label": 3
				},
				{
					"name": "public_dependency",
					"number": 10,
					"type": 5,
					"label": 3
				},
				{
					"name": "weak_dependency",
					"number": 11,
					"type": 5,
					"label": 3
				},
				{
					"name": "option_dependency",
					"number": 15,
					"type": 9,
					"label": 3
				},
				{
					"name": "message_type",
					"number": 4,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.DescriptorProto"
				},
				{
					"name": "enum_type",
					"number": 5,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.EnumDescriptorProto"
				},
				{
					"name": "service",
					"number": 6,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.ServiceDescriptorProto"
				},
				{
					"name": "extension",
					"number": 7,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.FieldDescriptorProto"
				},
				{
					"name": "options",
					"number": 8,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.FileOptions"
				},
				{
					"name": "source_code_info",
					"number": 9,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.SourceCodeInfo"
				},
				{
					"name": "syntax",
					"number": 12,
					"type": 9,
					"label": 1
				},
				{
					"name": "edition",
					"number": 14,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.Edition"
				}
			]
		},
		{
			"name": "DescriptorProto",
			"field": [
				{
					"name": "name",
					"number": 1,
					"type": 9,
					"label": 1
				},
				{
					"name": "field",
					"number": 2,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.FieldDescriptorProto"
				},
				{
					"name": "extension",
					"number": 6,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.FieldDescriptorProto"
				},
				{
					"name": "nested_type",
					"number": 3,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.DescriptorProto"
				},
				{
					"name": "enum_type",
					"number": 4,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.EnumDescriptorProto"
				},
				{
					"name": "extension_range",
					"number": 5,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.DescriptorProto.ExtensionRange"
				},
				{
					"name": "oneof_decl",
					"number": 8,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.OneofDescriptorProto"
				},
				{
					"name": "options",
					"number": 7,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.MessageOptions"
				},
				{
					"name": "reserved_range",
					"number": 9,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.DescriptorProto.ReservedRange"
				},
				{
					"name": "reserved_name",
					"number": 10,
					"type": 9,
					"label": 3
				},
				{
					"name": "visibility",
					"number": 11,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.SymbolVisibility"
				}
			],
			"nestedType": [{
				"name": "ExtensionRange",
				"field": [
					{
						"name": "start",
						"number": 1,
						"type": 5,
						"label": 1
					},
					{
						"name": "end",
						"number": 2,
						"type": 5,
						"label": 1
					},
					{
						"name": "options",
						"number": 3,
						"type": 11,
						"label": 1,
						"typeName": ".google.protobuf.ExtensionRangeOptions"
					}
				]
			}, {
				"name": "ReservedRange",
				"field": [{
					"name": "start",
					"number": 1,
					"type": 5,
					"label": 1
				}, {
					"name": "end",
					"number": 2,
					"type": 5,
					"label": 1
				}]
			}]
		},
		{
			"name": "ExtensionRangeOptions",
			"field": [
				{
					"name": "uninterpreted_option",
					"number": 999,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.UninterpretedOption"
				},
				{
					"name": "declaration",
					"number": 2,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.ExtensionRangeOptions.Declaration",
					"options": { "retention": 2 }
				},
				{
					"name": "features",
					"number": 50,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet"
				},
				{
					"name": "verification",
					"number": 3,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.ExtensionRangeOptions.VerificationState",
					"defaultValue": "UNVERIFIED",
					"options": { "retention": 2 }
				}
			],
			"nestedType": [{
				"name": "Declaration",
				"field": [
					{
						"name": "number",
						"number": 1,
						"type": 5,
						"label": 1
					},
					{
						"name": "full_name",
						"number": 2,
						"type": 9,
						"label": 1
					},
					{
						"name": "type",
						"number": 3,
						"type": 9,
						"label": 1
					},
					{
						"name": "reserved",
						"number": 5,
						"type": 8,
						"label": 1
					},
					{
						"name": "repeated",
						"number": 6,
						"type": 8,
						"label": 1
					}
				]
			}],
			"enumType": [{
				"name": "VerificationState",
				"value": [{
					"name": "DECLARATION",
					"number": 0
				}, {
					"name": "UNVERIFIED",
					"number": 1
				}]
			}],
			"extensionRange": [{
				"start": 1e3,
				"end": 536870912
			}]
		},
		{
			"name": "FieldDescriptorProto",
			"field": [
				{
					"name": "name",
					"number": 1,
					"type": 9,
					"label": 1
				},
				{
					"name": "number",
					"number": 3,
					"type": 5,
					"label": 1
				},
				{
					"name": "label",
					"number": 4,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.FieldDescriptorProto.Label"
				},
				{
					"name": "type",
					"number": 5,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.FieldDescriptorProto.Type"
				},
				{
					"name": "type_name",
					"number": 6,
					"type": 9,
					"label": 1
				},
				{
					"name": "extendee",
					"number": 2,
					"type": 9,
					"label": 1
				},
				{
					"name": "default_value",
					"number": 7,
					"type": 9,
					"label": 1
				},
				{
					"name": "oneof_index",
					"number": 9,
					"type": 5,
					"label": 1
				},
				{
					"name": "json_name",
					"number": 10,
					"type": 9,
					"label": 1
				},
				{
					"name": "options",
					"number": 8,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.FieldOptions"
				},
				{
					"name": "proto3_optional",
					"number": 17,
					"type": 8,
					"label": 1
				}
			],
			"enumType": [{
				"name": "Type",
				"value": [
					{
						"name": "TYPE_DOUBLE",
						"number": 1
					},
					{
						"name": "TYPE_FLOAT",
						"number": 2
					},
					{
						"name": "TYPE_INT64",
						"number": 3
					},
					{
						"name": "TYPE_UINT64",
						"number": 4
					},
					{
						"name": "TYPE_INT32",
						"number": 5
					},
					{
						"name": "TYPE_FIXED64",
						"number": 6
					},
					{
						"name": "TYPE_FIXED32",
						"number": 7
					},
					{
						"name": "TYPE_BOOL",
						"number": 8
					},
					{
						"name": "TYPE_STRING",
						"number": 9
					},
					{
						"name": "TYPE_GROUP",
						"number": 10
					},
					{
						"name": "TYPE_MESSAGE",
						"number": 11
					},
					{
						"name": "TYPE_BYTES",
						"number": 12
					},
					{
						"name": "TYPE_UINT32",
						"number": 13
					},
					{
						"name": "TYPE_ENUM",
						"number": 14
					},
					{
						"name": "TYPE_SFIXED32",
						"number": 15
					},
					{
						"name": "TYPE_SFIXED64",
						"number": 16
					},
					{
						"name": "TYPE_SINT32",
						"number": 17
					},
					{
						"name": "TYPE_SINT64",
						"number": 18
					}
				]
			}, {
				"name": "Label",
				"value": [
					{
						"name": "LABEL_OPTIONAL",
						"number": 1
					},
					{
						"name": "LABEL_REPEATED",
						"number": 3
					},
					{
						"name": "LABEL_REQUIRED",
						"number": 2
					}
				]
			}]
		},
		{
			"name": "OneofDescriptorProto",
			"field": [{
				"name": "name",
				"number": 1,
				"type": 9,
				"label": 1
			}, {
				"name": "options",
				"number": 2,
				"type": 11,
				"label": 1,
				"typeName": ".google.protobuf.OneofOptions"
			}]
		},
		{
			"name": "EnumDescriptorProto",
			"field": [
				{
					"name": "name",
					"number": 1,
					"type": 9,
					"label": 1
				},
				{
					"name": "value",
					"number": 2,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.EnumValueDescriptorProto"
				},
				{
					"name": "options",
					"number": 3,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.EnumOptions"
				},
				{
					"name": "reserved_range",
					"number": 4,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.EnumDescriptorProto.EnumReservedRange"
				},
				{
					"name": "reserved_name",
					"number": 5,
					"type": 9,
					"label": 3
				},
				{
					"name": "visibility",
					"number": 6,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.SymbolVisibility"
				}
			],
			"nestedType": [{
				"name": "EnumReservedRange",
				"field": [{
					"name": "start",
					"number": 1,
					"type": 5,
					"label": 1
				}, {
					"name": "end",
					"number": 2,
					"type": 5,
					"label": 1
				}]
			}]
		},
		{
			"name": "EnumValueDescriptorProto",
			"field": [
				{
					"name": "name",
					"number": 1,
					"type": 9,
					"label": 1
				},
				{
					"name": "number",
					"number": 2,
					"type": 5,
					"label": 1
				},
				{
					"name": "options",
					"number": 3,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.EnumValueOptions"
				}
			]
		},
		{
			"name": "ServiceDescriptorProto",
			"field": [
				{
					"name": "name",
					"number": 1,
					"type": 9,
					"label": 1
				},
				{
					"name": "method",
					"number": 2,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.MethodDescriptorProto"
				},
				{
					"name": "options",
					"number": 3,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.ServiceOptions"
				}
			]
		},
		{
			"name": "MethodDescriptorProto",
			"field": [
				{
					"name": "name",
					"number": 1,
					"type": 9,
					"label": 1
				},
				{
					"name": "input_type",
					"number": 2,
					"type": 9,
					"label": 1
				},
				{
					"name": "output_type",
					"number": 3,
					"type": 9,
					"label": 1
				},
				{
					"name": "options",
					"number": 4,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.MethodOptions"
				},
				{
					"name": "client_streaming",
					"number": 5,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "server_streaming",
					"number": 6,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				}
			]
		},
		{
			"name": "FileOptions",
			"field": [
				{
					"name": "java_package",
					"number": 1,
					"type": 9,
					"label": 1
				},
				{
					"name": "java_outer_classname",
					"number": 8,
					"type": 9,
					"label": 1
				},
				{
					"name": "java_multiple_files",
					"number": 10,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "java_generate_equals_and_hash",
					"number": 20,
					"type": 8,
					"label": 1,
					"options": { "deprecated": true }
				},
				{
					"name": "java_string_check_utf8",
					"number": 27,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "optimize_for",
					"number": 9,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.FileOptions.OptimizeMode",
					"defaultValue": "SPEED"
				},
				{
					"name": "go_package",
					"number": 11,
					"type": 9,
					"label": 1
				},
				{
					"name": "cc_generic_services",
					"number": 16,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "java_generic_services",
					"number": 17,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "py_generic_services",
					"number": 18,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "deprecated",
					"number": 23,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "cc_enable_arenas",
					"number": 31,
					"type": 8,
					"label": 1,
					"defaultValue": "true"
				},
				{
					"name": "objc_class_prefix",
					"number": 36,
					"type": 9,
					"label": 1
				},
				{
					"name": "csharp_namespace",
					"number": 37,
					"type": 9,
					"label": 1
				},
				{
					"name": "swift_prefix",
					"number": 39,
					"type": 9,
					"label": 1
				},
				{
					"name": "php_class_prefix",
					"number": 40,
					"type": 9,
					"label": 1
				},
				{
					"name": "php_namespace",
					"number": 41,
					"type": 9,
					"label": 1
				},
				{
					"name": "php_metadata_namespace",
					"number": 44,
					"type": 9,
					"label": 1
				},
				{
					"name": "ruby_package",
					"number": 45,
					"type": 9,
					"label": 1
				},
				{
					"name": "features",
					"number": 50,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet"
				},
				{
					"name": "uninterpreted_option",
					"number": 999,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.UninterpretedOption"
				}
			],
			"enumType": [{
				"name": "OptimizeMode",
				"value": [
					{
						"name": "SPEED",
						"number": 1
					},
					{
						"name": "CODE_SIZE",
						"number": 2
					},
					{
						"name": "LITE_RUNTIME",
						"number": 3
					}
				]
			}],
			"extensionRange": [{
				"start": 1e3,
				"end": 536870912
			}]
		},
		{
			"name": "MessageOptions",
			"field": [
				{
					"name": "message_set_wire_format",
					"number": 1,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "no_standard_descriptor_accessor",
					"number": 2,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "deprecated",
					"number": 3,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "map_entry",
					"number": 7,
					"type": 8,
					"label": 1
				},
				{
					"name": "deprecated_legacy_json_field_conflicts",
					"number": 11,
					"type": 8,
					"label": 1,
					"options": { "deprecated": true }
				},
				{
					"name": "features",
					"number": 12,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet"
				},
				{
					"name": "uninterpreted_option",
					"number": 999,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.UninterpretedOption"
				}
			],
			"extensionRange": [{
				"start": 1e3,
				"end": 536870912
			}]
		},
		{
			"name": "FieldOptions",
			"field": [
				{
					"name": "ctype",
					"number": 1,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.FieldOptions.CType",
					"defaultValue": "STRING"
				},
				{
					"name": "packed",
					"number": 2,
					"type": 8,
					"label": 1
				},
				{
					"name": "jstype",
					"number": 6,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.FieldOptions.JSType",
					"defaultValue": "JS_NORMAL"
				},
				{
					"name": "lazy",
					"number": 5,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "unverified_lazy",
					"number": 15,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "deprecated",
					"number": 3,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "weak",
					"number": 10,
					"type": 8,
					"label": 1,
					"defaultValue": "false",
					"options": { "deprecated": true }
				},
				{
					"name": "debug_redact",
					"number": 16,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "retention",
					"number": 17,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.FieldOptions.OptionRetention"
				},
				{
					"name": "targets",
					"number": 19,
					"type": 14,
					"label": 3,
					"typeName": ".google.protobuf.FieldOptions.OptionTargetType"
				},
				{
					"name": "edition_defaults",
					"number": 20,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.FieldOptions.EditionDefault"
				},
				{
					"name": "features",
					"number": 21,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet"
				},
				{
					"name": "feature_support",
					"number": 22,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.FieldOptions.FeatureSupport"
				},
				{
					"name": "uninterpreted_option",
					"number": 999,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.UninterpretedOption"
				}
			],
			"nestedType": [{
				"name": "EditionDefault",
				"field": [{
					"name": "edition",
					"number": 3,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.Edition"
				}, {
					"name": "value",
					"number": 2,
					"type": 9,
					"label": 1
				}]
			}, {
				"name": "FeatureSupport",
				"field": [
					{
						"name": "edition_introduced",
						"number": 1,
						"type": 14,
						"label": 1,
						"typeName": ".google.protobuf.Edition"
					},
					{
						"name": "edition_deprecated",
						"number": 2,
						"type": 14,
						"label": 1,
						"typeName": ".google.protobuf.Edition"
					},
					{
						"name": "deprecation_warning",
						"number": 3,
						"type": 9,
						"label": 1
					},
					{
						"name": "edition_removed",
						"number": 4,
						"type": 14,
						"label": 1,
						"typeName": ".google.protobuf.Edition"
					}
				]
			}],
			"enumType": [
				{
					"name": "CType",
					"value": [
						{
							"name": "STRING",
							"number": 0
						},
						{
							"name": "CORD",
							"number": 1
						},
						{
							"name": "STRING_PIECE",
							"number": 2
						}
					]
				},
				{
					"name": "JSType",
					"value": [
						{
							"name": "JS_NORMAL",
							"number": 0
						},
						{
							"name": "JS_STRING",
							"number": 1
						},
						{
							"name": "JS_NUMBER",
							"number": 2
						}
					]
				},
				{
					"name": "OptionRetention",
					"value": [
						{
							"name": "RETENTION_UNKNOWN",
							"number": 0
						},
						{
							"name": "RETENTION_RUNTIME",
							"number": 1
						},
						{
							"name": "RETENTION_SOURCE",
							"number": 2
						}
					]
				},
				{
					"name": "OptionTargetType",
					"value": [
						{
							"name": "TARGET_TYPE_UNKNOWN",
							"number": 0
						},
						{
							"name": "TARGET_TYPE_FILE",
							"number": 1
						},
						{
							"name": "TARGET_TYPE_EXTENSION_RANGE",
							"number": 2
						},
						{
							"name": "TARGET_TYPE_MESSAGE",
							"number": 3
						},
						{
							"name": "TARGET_TYPE_FIELD",
							"number": 4
						},
						{
							"name": "TARGET_TYPE_ONEOF",
							"number": 5
						},
						{
							"name": "TARGET_TYPE_ENUM",
							"number": 6
						},
						{
							"name": "TARGET_TYPE_ENUM_ENTRY",
							"number": 7
						},
						{
							"name": "TARGET_TYPE_SERVICE",
							"number": 8
						},
						{
							"name": "TARGET_TYPE_METHOD",
							"number": 9
						}
					]
				}
			],
			"extensionRange": [{
				"start": 1e3,
				"end": 536870912
			}]
		},
		{
			"name": "OneofOptions",
			"field": [{
				"name": "features",
				"number": 1,
				"type": 11,
				"label": 1,
				"typeName": ".google.protobuf.FeatureSet"
			}, {
				"name": "uninterpreted_option",
				"number": 999,
				"type": 11,
				"label": 3,
				"typeName": ".google.protobuf.UninterpretedOption"
			}],
			"extensionRange": [{
				"start": 1e3,
				"end": 536870912
			}]
		},
		{
			"name": "EnumOptions",
			"field": [
				{
					"name": "allow_alias",
					"number": 2,
					"type": 8,
					"label": 1
				},
				{
					"name": "deprecated",
					"number": 3,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "deprecated_legacy_json_field_conflicts",
					"number": 6,
					"type": 8,
					"label": 1,
					"options": { "deprecated": true }
				},
				{
					"name": "features",
					"number": 7,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet"
				},
				{
					"name": "uninterpreted_option",
					"number": 999,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.UninterpretedOption"
				}
			],
			"extensionRange": [{
				"start": 1e3,
				"end": 536870912
			}]
		},
		{
			"name": "EnumValueOptions",
			"field": [
				{
					"name": "deprecated",
					"number": 1,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "features",
					"number": 2,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet"
				},
				{
					"name": "debug_redact",
					"number": 3,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "feature_support",
					"number": 4,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.FieldOptions.FeatureSupport"
				},
				{
					"name": "uninterpreted_option",
					"number": 999,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.UninterpretedOption"
				}
			],
			"extensionRange": [{
				"start": 1e3,
				"end": 536870912
			}]
		},
		{
			"name": "ServiceOptions",
			"field": [
				{
					"name": "features",
					"number": 34,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet"
				},
				{
					"name": "deprecated",
					"number": 33,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "uninterpreted_option",
					"number": 999,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.UninterpretedOption"
				}
			],
			"extensionRange": [{
				"start": 1e3,
				"end": 536870912
			}]
		},
		{
			"name": "MethodOptions",
			"field": [
				{
					"name": "deprecated",
					"number": 33,
					"type": 8,
					"label": 1,
					"defaultValue": "false"
				},
				{
					"name": "idempotency_level",
					"number": 34,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.MethodOptions.IdempotencyLevel",
					"defaultValue": "IDEMPOTENCY_UNKNOWN"
				},
				{
					"name": "features",
					"number": 35,
					"type": 11,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet"
				},
				{
					"name": "uninterpreted_option",
					"number": 999,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.UninterpretedOption"
				}
			],
			"enumType": [{
				"name": "IdempotencyLevel",
				"value": [
					{
						"name": "IDEMPOTENCY_UNKNOWN",
						"number": 0
					},
					{
						"name": "NO_SIDE_EFFECTS",
						"number": 1
					},
					{
						"name": "IDEMPOTENT",
						"number": 2
					}
				]
			}],
			"extensionRange": [{
				"start": 1e3,
				"end": 536870912
			}]
		},
		{
			"name": "UninterpretedOption",
			"field": [
				{
					"name": "name",
					"number": 2,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.UninterpretedOption.NamePart"
				},
				{
					"name": "identifier_value",
					"number": 3,
					"type": 9,
					"label": 1
				},
				{
					"name": "positive_int_value",
					"number": 4,
					"type": 4,
					"label": 1
				},
				{
					"name": "negative_int_value",
					"number": 5,
					"type": 3,
					"label": 1
				},
				{
					"name": "double_value",
					"number": 6,
					"type": 1,
					"label": 1
				},
				{
					"name": "string_value",
					"number": 7,
					"type": 12,
					"label": 1
				},
				{
					"name": "aggregate_value",
					"number": 8,
					"type": 9,
					"label": 1
				}
			],
			"nestedType": [{
				"name": "NamePart",
				"field": [{
					"name": "name_part",
					"number": 1,
					"type": 9,
					"label": 2
				}, {
					"name": "is_extension",
					"number": 2,
					"type": 8,
					"label": 2
				}]
			}]
		},
		{
			"name": "FeatureSet",
			"field": [
				{
					"name": "field_presence",
					"number": 1,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet.FieldPresence",
					"options": {
						"retention": 1,
						"targets": [4, 1],
						"editionDefaults": [
							{
								"value": "EXPLICIT",
								"edition": 900
							},
							{
								"value": "IMPLICIT",
								"edition": 999
							},
							{
								"value": "EXPLICIT",
								"edition": 1e3
							}
						]
					}
				},
				{
					"name": "enum_type",
					"number": 2,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet.EnumType",
					"options": {
						"retention": 1,
						"targets": [6, 1],
						"editionDefaults": [{
							"value": "CLOSED",
							"edition": 900
						}, {
							"value": "OPEN",
							"edition": 999
						}]
					}
				},
				{
					"name": "repeated_field_encoding",
					"number": 3,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet.RepeatedFieldEncoding",
					"options": {
						"retention": 1,
						"targets": [4, 1],
						"editionDefaults": [{
							"value": "EXPANDED",
							"edition": 900
						}, {
							"value": "PACKED",
							"edition": 999
						}]
					}
				},
				{
					"name": "utf8_validation",
					"number": 4,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet.Utf8Validation",
					"options": {
						"retention": 1,
						"targets": [4, 1],
						"editionDefaults": [{
							"value": "NONE",
							"edition": 900
						}, {
							"value": "VERIFY",
							"edition": 999
						}]
					}
				},
				{
					"name": "message_encoding",
					"number": 5,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet.MessageEncoding",
					"options": {
						"retention": 1,
						"targets": [4, 1],
						"editionDefaults": [{
							"value": "LENGTH_PREFIXED",
							"edition": 900
						}]
					}
				},
				{
					"name": "json_format",
					"number": 6,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet.JsonFormat",
					"options": {
						"retention": 1,
						"targets": [
							3,
							6,
							1
						],
						"editionDefaults": [{
							"value": "LEGACY_BEST_EFFORT",
							"edition": 900
						}, {
							"value": "ALLOW",
							"edition": 999
						}]
					}
				},
				{
					"name": "enforce_naming_style",
					"number": 7,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet.EnforceNamingStyle",
					"options": {
						"retention": 2,
						"targets": [
							1,
							2,
							3,
							4,
							5,
							6,
							7,
							8,
							9
						],
						"editionDefaults": [{
							"value": "STYLE_LEGACY",
							"edition": 900
						}, {
							"value": "STYLE2024",
							"edition": 1001
						}]
					}
				},
				{
					"name": "default_symbol_visibility",
					"number": 8,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.FeatureSet.VisibilityFeature.DefaultSymbolVisibility",
					"options": {
						"retention": 2,
						"targets": [1],
						"editionDefaults": [{
							"value": "EXPORT_ALL",
							"edition": 900
						}, {
							"value": "EXPORT_TOP_LEVEL",
							"edition": 1001
						}]
					}
				}
			],
			"nestedType": [{
				"name": "VisibilityFeature",
				"enumType": [{
					"name": "DefaultSymbolVisibility",
					"value": [
						{
							"name": "DEFAULT_SYMBOL_VISIBILITY_UNKNOWN",
							"number": 0
						},
						{
							"name": "EXPORT_ALL",
							"number": 1
						},
						{
							"name": "EXPORT_TOP_LEVEL",
							"number": 2
						},
						{
							"name": "LOCAL_ALL",
							"number": 3
						},
						{
							"name": "STRICT",
							"number": 4
						}
					]
				}]
			}],
			"enumType": [
				{
					"name": "FieldPresence",
					"value": [
						{
							"name": "FIELD_PRESENCE_UNKNOWN",
							"number": 0
						},
						{
							"name": "EXPLICIT",
							"number": 1
						},
						{
							"name": "IMPLICIT",
							"number": 2
						},
						{
							"name": "LEGACY_REQUIRED",
							"number": 3
						}
					]
				},
				{
					"name": "EnumType",
					"value": [
						{
							"name": "ENUM_TYPE_UNKNOWN",
							"number": 0
						},
						{
							"name": "OPEN",
							"number": 1
						},
						{
							"name": "CLOSED",
							"number": 2
						}
					]
				},
				{
					"name": "RepeatedFieldEncoding",
					"value": [
						{
							"name": "REPEATED_FIELD_ENCODING_UNKNOWN",
							"number": 0
						},
						{
							"name": "PACKED",
							"number": 1
						},
						{
							"name": "EXPANDED",
							"number": 2
						}
					]
				},
				{
					"name": "Utf8Validation",
					"value": [
						{
							"name": "UTF8_VALIDATION_UNKNOWN",
							"number": 0
						},
						{
							"name": "VERIFY",
							"number": 2
						},
						{
							"name": "NONE",
							"number": 3
						}
					]
				},
				{
					"name": "MessageEncoding",
					"value": [
						{
							"name": "MESSAGE_ENCODING_UNKNOWN",
							"number": 0
						},
						{
							"name": "LENGTH_PREFIXED",
							"number": 1
						},
						{
							"name": "DELIMITED",
							"number": 2
						}
					]
				},
				{
					"name": "JsonFormat",
					"value": [
						{
							"name": "JSON_FORMAT_UNKNOWN",
							"number": 0
						},
						{
							"name": "ALLOW",
							"number": 1
						},
						{
							"name": "LEGACY_BEST_EFFORT",
							"number": 2
						}
					]
				},
				{
					"name": "EnforceNamingStyle",
					"value": [
						{
							"name": "ENFORCE_NAMING_STYLE_UNKNOWN",
							"number": 0
						},
						{
							"name": "STYLE2024",
							"number": 1
						},
						{
							"name": "STYLE_LEGACY",
							"number": 2
						}
					]
				}
			],
			"extensionRange": [
				{
					"start": 1e3,
					"end": 9995
				},
				{
					"start": 9995,
					"end": 1e4
				},
				{
					"start": 1e4,
					"end": 10001
				}
			]
		},
		{
			"name": "FeatureSetDefaults",
			"field": [
				{
					"name": "defaults",
					"number": 1,
					"type": 11,
					"label": 3,
					"typeName": ".google.protobuf.FeatureSetDefaults.FeatureSetEditionDefault"
				},
				{
					"name": "minimum_edition",
					"number": 4,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.Edition"
				},
				{
					"name": "maximum_edition",
					"number": 5,
					"type": 14,
					"label": 1,
					"typeName": ".google.protobuf.Edition"
				}
			],
			"nestedType": [{
				"name": "FeatureSetEditionDefault",
				"field": [
					{
						"name": "edition",
						"number": 3,
						"type": 14,
						"label": 1,
						"typeName": ".google.protobuf.Edition"
					},
					{
						"name": "overridable_features",
						"number": 4,
						"type": 11,
						"label": 1,
						"typeName": ".google.protobuf.FeatureSet"
					},
					{
						"name": "fixed_features",
						"number": 5,
						"type": 11,
						"label": 1,
						"typeName": ".google.protobuf.FeatureSet"
					}
				]
			}]
		},
		{
			"name": "SourceCodeInfo",
			"field": [{
				"name": "location",
				"number": 1,
				"type": 11,
				"label": 3,
				"typeName": ".google.protobuf.SourceCodeInfo.Location"
			}],
			"nestedType": [{
				"name": "Location",
				"field": [
					{
						"name": "path",
						"number": 1,
						"type": 5,
						"label": 3,
						"options": { "packed": true }
					},
					{
						"name": "span",
						"number": 2,
						"type": 5,
						"label": 3,
						"options": { "packed": true }
					},
					{
						"name": "leading_comments",
						"number": 3,
						"type": 9,
						"label": 1
					},
					{
						"name": "trailing_comments",
						"number": 4,
						"type": 9,
						"label": 1
					},
					{
						"name": "leading_detached_comments",
						"number": 6,
						"type": 9,
						"label": 3
					}
				]
			}],
			"extensionRange": [{
				"start": 536e6,
				"end": 536000001
			}]
		},
		{
			"name": "GeneratedCodeInfo",
			"field": [{
				"name": "annotation",
				"number": 1,
				"type": 11,
				"label": 3,
				"typeName": ".google.protobuf.GeneratedCodeInfo.Annotation"
			}],
			"nestedType": [{
				"name": "Annotation",
				"field": [
					{
						"name": "path",
						"number": 1,
						"type": 5,
						"label": 3,
						"options": { "packed": true }
					},
					{
						"name": "source_file",
						"number": 2,
						"type": 9,
						"label": 1
					},
					{
						"name": "begin",
						"number": 3,
						"type": 5,
						"label": 1
					},
					{
						"name": "end",
						"number": 4,
						"type": 5,
						"label": 1
					},
					{
						"name": "semantic",
						"number": 5,
						"type": 14,
						"label": 1,
						"typeName": ".google.protobuf.GeneratedCodeInfo.Annotation.Semantic"
					}
				],
				"enumType": [{
					"name": "Semantic",
					"value": [
						{
							"name": "NONE",
							"number": 0
						},
						{
							"name": "SET",
							"number": 1
						},
						{
							"name": "ALIAS",
							"number": 2
						}
					]
				}]
			}]
		}
	],
	"enumType": [{
		"name": "Edition",
		"value": [
			{
				"name": "EDITION_UNKNOWN",
				"number": 0
			},
			{
				"name": "EDITION_LEGACY",
				"number": 900
			},
			{
				"name": "EDITION_PROTO2",
				"number": 998
			},
			{
				"name": "EDITION_PROTO3",
				"number": 999
			},
			{
				"name": "EDITION_2023",
				"number": 1e3
			},
			{
				"name": "EDITION_2024",
				"number": 1001
			},
			{
				"name": "EDITION_UNSTABLE",
				"number": 9999
			},
			{
				"name": "EDITION_1_TEST_ONLY",
				"number": 1
			},
			{
				"name": "EDITION_2_TEST_ONLY",
				"number": 2
			},
			{
				"name": "EDITION_99997_TEST_ONLY",
				"number": 99997
			},
			{
				"name": "EDITION_99998_TEST_ONLY",
				"number": 99998
			},
			{
				"name": "EDITION_99999_TEST_ONLY",
				"number": 99999
			},
			{
				"name": "EDITION_MAX",
				"number": 2147483647
			}
		]
	}, {
		"name": "SymbolVisibility",
		"value": [
			{
				"name": "VISIBILITY_UNSET",
				"number": 0
			},
			{
				"name": "VISIBILITY_LOCAL",
				"number": 1
			},
			{
				"name": "VISIBILITY_EXPORT",
				"number": 2
			}
		]
	}]
}), 1);
/**
* The verification state of the extension range.
*
* @generated from enum google.protobuf.ExtensionRangeOptions.VerificationState
*/
var ExtensionRangeOptions_VerificationState;
(function(ExtensionRangeOptions_VerificationState) {
	/**
	* All the extensions of the range must be declared.
	*
	* @generated from enum value: DECLARATION = 0;
	*/
	ExtensionRangeOptions_VerificationState[ExtensionRangeOptions_VerificationState["DECLARATION"] = 0] = "DECLARATION";
	/**
	* @generated from enum value: UNVERIFIED = 1;
	*/
	ExtensionRangeOptions_VerificationState[ExtensionRangeOptions_VerificationState["UNVERIFIED"] = 1] = "UNVERIFIED";
})(ExtensionRangeOptions_VerificationState || (ExtensionRangeOptions_VerificationState = {}));
/**
* @generated from enum google.protobuf.FieldDescriptorProto.Type
*/
var FieldDescriptorProto_Type;
(function(FieldDescriptorProto_Type) {
	/**
	* 0 is reserved for errors.
	* Order is weird for historical reasons.
	*
	* @generated from enum value: TYPE_DOUBLE = 1;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["DOUBLE"] = 1] = "DOUBLE";
	/**
	* @generated from enum value: TYPE_FLOAT = 2;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["FLOAT"] = 2] = "FLOAT";
	/**
	* Not ZigZag encoded.  Negative numbers take 10 bytes.  Use TYPE_SINT64 if
	* negative values are likely.
	*
	* @generated from enum value: TYPE_INT64 = 3;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["INT64"] = 3] = "INT64";
	/**
	* @generated from enum value: TYPE_UINT64 = 4;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["UINT64"] = 4] = "UINT64";
	/**
	* Not ZigZag encoded.  Negative numbers take 10 bytes.  Use TYPE_SINT32 if
	* negative values are likely.
	*
	* @generated from enum value: TYPE_INT32 = 5;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["INT32"] = 5] = "INT32";
	/**
	* @generated from enum value: TYPE_FIXED64 = 6;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["FIXED64"] = 6] = "FIXED64";
	/**
	* @generated from enum value: TYPE_FIXED32 = 7;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["FIXED32"] = 7] = "FIXED32";
	/**
	* @generated from enum value: TYPE_BOOL = 8;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["BOOL"] = 8] = "BOOL";
	/**
	* @generated from enum value: TYPE_STRING = 9;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["STRING"] = 9] = "STRING";
	/**
	* Tag-delimited aggregate.
	* Group type is deprecated and not supported after google.protobuf. However, Proto3
	* implementations should still be able to parse the group wire format and
	* treat group fields as unknown fields.  In Editions, the group wire format
	* can be enabled via the `message_encoding` feature.
	*
	* @generated from enum value: TYPE_GROUP = 10;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["GROUP"] = 10] = "GROUP";
	/**
	* Length-delimited aggregate.
	*
	* @generated from enum value: TYPE_MESSAGE = 11;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["MESSAGE"] = 11] = "MESSAGE";
	/**
	* New in version 2.
	*
	* @generated from enum value: TYPE_BYTES = 12;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["BYTES"] = 12] = "BYTES";
	/**
	* @generated from enum value: TYPE_UINT32 = 13;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["UINT32"] = 13] = "UINT32";
	/**
	* @generated from enum value: TYPE_ENUM = 14;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["ENUM"] = 14] = "ENUM";
	/**
	* @generated from enum value: TYPE_SFIXED32 = 15;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["SFIXED32"] = 15] = "SFIXED32";
	/**
	* @generated from enum value: TYPE_SFIXED64 = 16;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["SFIXED64"] = 16] = "SFIXED64";
	/**
	* Uses ZigZag encoding.
	*
	* @generated from enum value: TYPE_SINT32 = 17;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["SINT32"] = 17] = "SINT32";
	/**
	* Uses ZigZag encoding.
	*
	* @generated from enum value: TYPE_SINT64 = 18;
	*/
	FieldDescriptorProto_Type[FieldDescriptorProto_Type["SINT64"] = 18] = "SINT64";
})(FieldDescriptorProto_Type || (FieldDescriptorProto_Type = {}));
/**
* @generated from enum google.protobuf.FieldDescriptorProto.Label
*/
var FieldDescriptorProto_Label;
(function(FieldDescriptorProto_Label) {
	/**
	* 0 is reserved for errors
	*
	* @generated from enum value: LABEL_OPTIONAL = 1;
	*/
	FieldDescriptorProto_Label[FieldDescriptorProto_Label["OPTIONAL"] = 1] = "OPTIONAL";
	/**
	* @generated from enum value: LABEL_REPEATED = 3;
	*/
	FieldDescriptorProto_Label[FieldDescriptorProto_Label["REPEATED"] = 3] = "REPEATED";
	/**
	* The required label is only allowed in google.protobuf.  In proto3 and Editions
	* it's explicitly prohibited.  In Editions, the `field_presence` feature
	* can be used to get this behavior.
	*
	* @generated from enum value: LABEL_REQUIRED = 2;
	*/
	FieldDescriptorProto_Label[FieldDescriptorProto_Label["REQUIRED"] = 2] = "REQUIRED";
})(FieldDescriptorProto_Label || (FieldDescriptorProto_Label = {}));
/**
* Generated classes can be optimized for speed or code size.
*
* @generated from enum google.protobuf.FileOptions.OptimizeMode
*/
var FileOptions_OptimizeMode;
(function(FileOptions_OptimizeMode) {
	/**
	* Generate complete code for parsing, serialization,
	*
	* @generated from enum value: SPEED = 1;
	*/
	FileOptions_OptimizeMode[FileOptions_OptimizeMode["SPEED"] = 1] = "SPEED";
	/**
	* etc.
	*
	* Use ReflectionOps to implement these methods.
	*
	* @generated from enum value: CODE_SIZE = 2;
	*/
	FileOptions_OptimizeMode[FileOptions_OptimizeMode["CODE_SIZE"] = 2] = "CODE_SIZE";
	/**
	* Generate code using MessageLite and the lite runtime.
	*
	* @generated from enum value: LITE_RUNTIME = 3;
	*/
	FileOptions_OptimizeMode[FileOptions_OptimizeMode["LITE_RUNTIME"] = 3] = "LITE_RUNTIME";
})(FileOptions_OptimizeMode || (FileOptions_OptimizeMode = {}));
/**
* @generated from enum google.protobuf.FieldOptions.CType
*/
var FieldOptions_CType;
(function(FieldOptions_CType) {
	/**
	* Default mode.
	*
	* @generated from enum value: STRING = 0;
	*/
	FieldOptions_CType[FieldOptions_CType["STRING"] = 0] = "STRING";
	/**
	* The option [ctype=CORD] may be applied to a non-repeated field of type
	* "bytes". It indicates that in C++, the data should be stored in a Cord
	* instead of a string.  For very large strings, this may reduce memory
	* fragmentation. It may also allow better performance when parsing from a
	* Cord, or when parsing with aliasing enabled, as the parsed Cord may then
	* alias the original buffer.
	*
	* @generated from enum value: CORD = 1;
	*/
	FieldOptions_CType[FieldOptions_CType["CORD"] = 1] = "CORD";
	/**
	* @generated from enum value: STRING_PIECE = 2;
	*/
	FieldOptions_CType[FieldOptions_CType["STRING_PIECE"] = 2] = "STRING_PIECE";
})(FieldOptions_CType || (FieldOptions_CType = {}));
/**
* @generated from enum google.protobuf.FieldOptions.JSType
*/
var FieldOptions_JSType;
(function(FieldOptions_JSType) {
	/**
	* Use the default type.
	*
	* @generated from enum value: JS_NORMAL = 0;
	*/
	FieldOptions_JSType[FieldOptions_JSType["JS_NORMAL"] = 0] = "JS_NORMAL";
	/**
	* Use JavaScript strings.
	*
	* @generated from enum value: JS_STRING = 1;
	*/
	FieldOptions_JSType[FieldOptions_JSType["JS_STRING"] = 1] = "JS_STRING";
	/**
	* Use JavaScript numbers.
	*
	* @generated from enum value: JS_NUMBER = 2;
	*/
	FieldOptions_JSType[FieldOptions_JSType["JS_NUMBER"] = 2] = "JS_NUMBER";
})(FieldOptions_JSType || (FieldOptions_JSType = {}));
/**
* If set to RETENTION_SOURCE, the option will be omitted from the binary.
*
* @generated from enum google.protobuf.FieldOptions.OptionRetention
*/
var FieldOptions_OptionRetention;
(function(FieldOptions_OptionRetention) {
	/**
	* @generated from enum value: RETENTION_UNKNOWN = 0;
	*/
	FieldOptions_OptionRetention[FieldOptions_OptionRetention["RETENTION_UNKNOWN"] = 0] = "RETENTION_UNKNOWN";
	/**
	* @generated from enum value: RETENTION_RUNTIME = 1;
	*/
	FieldOptions_OptionRetention[FieldOptions_OptionRetention["RETENTION_RUNTIME"] = 1] = "RETENTION_RUNTIME";
	/**
	* @generated from enum value: RETENTION_SOURCE = 2;
	*/
	FieldOptions_OptionRetention[FieldOptions_OptionRetention["RETENTION_SOURCE"] = 2] = "RETENTION_SOURCE";
})(FieldOptions_OptionRetention || (FieldOptions_OptionRetention = {}));
/**
* This indicates the types of entities that the field may apply to when used
* as an option. If it is unset, then the field may be freely used as an
* option on any kind of entity.
*
* @generated from enum google.protobuf.FieldOptions.OptionTargetType
*/
var FieldOptions_OptionTargetType;
(function(FieldOptions_OptionTargetType) {
	/**
	* @generated from enum value: TARGET_TYPE_UNKNOWN = 0;
	*/
	FieldOptions_OptionTargetType[FieldOptions_OptionTargetType["TARGET_TYPE_UNKNOWN"] = 0] = "TARGET_TYPE_UNKNOWN";
	/**
	* @generated from enum value: TARGET_TYPE_FILE = 1;
	*/
	FieldOptions_OptionTargetType[FieldOptions_OptionTargetType["TARGET_TYPE_FILE"] = 1] = "TARGET_TYPE_FILE";
	/**
	* @generated from enum value: TARGET_TYPE_EXTENSION_RANGE = 2;
	*/
	FieldOptions_OptionTargetType[FieldOptions_OptionTargetType["TARGET_TYPE_EXTENSION_RANGE"] = 2] = "TARGET_TYPE_EXTENSION_RANGE";
	/**
	* @generated from enum value: TARGET_TYPE_MESSAGE = 3;
	*/
	FieldOptions_OptionTargetType[FieldOptions_OptionTargetType["TARGET_TYPE_MESSAGE"] = 3] = "TARGET_TYPE_MESSAGE";
	/**
	* @generated from enum value: TARGET_TYPE_FIELD = 4;
	*/
	FieldOptions_OptionTargetType[FieldOptions_OptionTargetType["TARGET_TYPE_FIELD"] = 4] = "TARGET_TYPE_FIELD";
	/**
	* @generated from enum value: TARGET_TYPE_ONEOF = 5;
	*/
	FieldOptions_OptionTargetType[FieldOptions_OptionTargetType["TARGET_TYPE_ONEOF"] = 5] = "TARGET_TYPE_ONEOF";
	/**
	* @generated from enum value: TARGET_TYPE_ENUM = 6;
	*/
	FieldOptions_OptionTargetType[FieldOptions_OptionTargetType["TARGET_TYPE_ENUM"] = 6] = "TARGET_TYPE_ENUM";
	/**
	* @generated from enum value: TARGET_TYPE_ENUM_ENTRY = 7;
	*/
	FieldOptions_OptionTargetType[FieldOptions_OptionTargetType["TARGET_TYPE_ENUM_ENTRY"] = 7] = "TARGET_TYPE_ENUM_ENTRY";
	/**
	* @generated from enum value: TARGET_TYPE_SERVICE = 8;
	*/
	FieldOptions_OptionTargetType[FieldOptions_OptionTargetType["TARGET_TYPE_SERVICE"] = 8] = "TARGET_TYPE_SERVICE";
	/**
	* @generated from enum value: TARGET_TYPE_METHOD = 9;
	*/
	FieldOptions_OptionTargetType[FieldOptions_OptionTargetType["TARGET_TYPE_METHOD"] = 9] = "TARGET_TYPE_METHOD";
})(FieldOptions_OptionTargetType || (FieldOptions_OptionTargetType = {}));
/**
* Is this method side-effect-free (or safe in HTTP parlance), or idempotent,
* or neither? HTTP based RPC implementation may choose GET verb for safe
* methods, and PUT verb for idempotent methods instead of the default POST.
*
* @generated from enum google.protobuf.MethodOptions.IdempotencyLevel
*/
var MethodOptions_IdempotencyLevel;
(function(MethodOptions_IdempotencyLevel) {
	/**
	* @generated from enum value: IDEMPOTENCY_UNKNOWN = 0;
	*/
	MethodOptions_IdempotencyLevel[MethodOptions_IdempotencyLevel["IDEMPOTENCY_UNKNOWN"] = 0] = "IDEMPOTENCY_UNKNOWN";
	/**
	* implies idempotent
	*
	* @generated from enum value: NO_SIDE_EFFECTS = 1;
	*/
	MethodOptions_IdempotencyLevel[MethodOptions_IdempotencyLevel["NO_SIDE_EFFECTS"] = 1] = "NO_SIDE_EFFECTS";
	/**
	* idempotent, but may have side effects
	*
	* @generated from enum value: IDEMPOTENT = 2;
	*/
	MethodOptions_IdempotencyLevel[MethodOptions_IdempotencyLevel["IDEMPOTENT"] = 2] = "IDEMPOTENT";
})(MethodOptions_IdempotencyLevel || (MethodOptions_IdempotencyLevel = {}));
/**
* @generated from enum google.protobuf.FeatureSet.VisibilityFeature.DefaultSymbolVisibility
*/
var FeatureSet_VisibilityFeature_DefaultSymbolVisibility;
(function(FeatureSet_VisibilityFeature_DefaultSymbolVisibility) {
	/**
	* @generated from enum value: DEFAULT_SYMBOL_VISIBILITY_UNKNOWN = 0;
	*/
	FeatureSet_VisibilityFeature_DefaultSymbolVisibility[FeatureSet_VisibilityFeature_DefaultSymbolVisibility["DEFAULT_SYMBOL_VISIBILITY_UNKNOWN"] = 0] = "DEFAULT_SYMBOL_VISIBILITY_UNKNOWN";
	/**
	* Default pre-EDITION_2024, all UNSET visibility are export.
	*
	* @generated from enum value: EXPORT_ALL = 1;
	*/
	FeatureSet_VisibilityFeature_DefaultSymbolVisibility[FeatureSet_VisibilityFeature_DefaultSymbolVisibility["EXPORT_ALL"] = 1] = "EXPORT_ALL";
	/**
	* All top-level symbols default to export, nested default to local.
	*
	* @generated from enum value: EXPORT_TOP_LEVEL = 2;
	*/
	FeatureSet_VisibilityFeature_DefaultSymbolVisibility[FeatureSet_VisibilityFeature_DefaultSymbolVisibility["EXPORT_TOP_LEVEL"] = 2] = "EXPORT_TOP_LEVEL";
	/**
	* All symbols default to local.
	*
	* @generated from enum value: LOCAL_ALL = 3;
	*/
	FeatureSet_VisibilityFeature_DefaultSymbolVisibility[FeatureSet_VisibilityFeature_DefaultSymbolVisibility["LOCAL_ALL"] = 3] = "LOCAL_ALL";
	/**
	* All symbols local by default. Nested types cannot be exported.
	* With special case caveat for message { enum {} reserved 1 to max; }
	* This is the recommended setting for new protos.
	*
	* @generated from enum value: STRICT = 4;
	*/
	FeatureSet_VisibilityFeature_DefaultSymbolVisibility[FeatureSet_VisibilityFeature_DefaultSymbolVisibility["STRICT"] = 4] = "STRICT";
})(FeatureSet_VisibilityFeature_DefaultSymbolVisibility || (FeatureSet_VisibilityFeature_DefaultSymbolVisibility = {}));
/**
* @generated from enum google.protobuf.FeatureSet.FieldPresence
*/
var FeatureSet_FieldPresence;
(function(FeatureSet_FieldPresence) {
	/**
	* @generated from enum value: FIELD_PRESENCE_UNKNOWN = 0;
	*/
	FeatureSet_FieldPresence[FeatureSet_FieldPresence["FIELD_PRESENCE_UNKNOWN"] = 0] = "FIELD_PRESENCE_UNKNOWN";
	/**
	* @generated from enum value: EXPLICIT = 1;
	*/
	FeatureSet_FieldPresence[FeatureSet_FieldPresence["EXPLICIT"] = 1] = "EXPLICIT";
	/**
	* @generated from enum value: IMPLICIT = 2;
	*/
	FeatureSet_FieldPresence[FeatureSet_FieldPresence["IMPLICIT"] = 2] = "IMPLICIT";
	/**
	* @generated from enum value: LEGACY_REQUIRED = 3;
	*/
	FeatureSet_FieldPresence[FeatureSet_FieldPresence["LEGACY_REQUIRED"] = 3] = "LEGACY_REQUIRED";
})(FeatureSet_FieldPresence || (FeatureSet_FieldPresence = {}));
/**
* @generated from enum google.protobuf.FeatureSet.EnumType
*/
var FeatureSet_EnumType;
(function(FeatureSet_EnumType) {
	/**
	* @generated from enum value: ENUM_TYPE_UNKNOWN = 0;
	*/
	FeatureSet_EnumType[FeatureSet_EnumType["ENUM_TYPE_UNKNOWN"] = 0] = "ENUM_TYPE_UNKNOWN";
	/**
	* @generated from enum value: OPEN = 1;
	*/
	FeatureSet_EnumType[FeatureSet_EnumType["OPEN"] = 1] = "OPEN";
	/**
	* @generated from enum value: CLOSED = 2;
	*/
	FeatureSet_EnumType[FeatureSet_EnumType["CLOSED"] = 2] = "CLOSED";
})(FeatureSet_EnumType || (FeatureSet_EnumType = {}));
/**
* @generated from enum google.protobuf.FeatureSet.RepeatedFieldEncoding
*/
var FeatureSet_RepeatedFieldEncoding;
(function(FeatureSet_RepeatedFieldEncoding) {
	/**
	* @generated from enum value: REPEATED_FIELD_ENCODING_UNKNOWN = 0;
	*/
	FeatureSet_RepeatedFieldEncoding[FeatureSet_RepeatedFieldEncoding["REPEATED_FIELD_ENCODING_UNKNOWN"] = 0] = "REPEATED_FIELD_ENCODING_UNKNOWN";
	/**
	* @generated from enum value: PACKED = 1;
	*/
	FeatureSet_RepeatedFieldEncoding[FeatureSet_RepeatedFieldEncoding["PACKED"] = 1] = "PACKED";
	/**
	* @generated from enum value: EXPANDED = 2;
	*/
	FeatureSet_RepeatedFieldEncoding[FeatureSet_RepeatedFieldEncoding["EXPANDED"] = 2] = "EXPANDED";
})(FeatureSet_RepeatedFieldEncoding || (FeatureSet_RepeatedFieldEncoding = {}));
/**
* @generated from enum google.protobuf.FeatureSet.Utf8Validation
*/
var FeatureSet_Utf8Validation;
(function(FeatureSet_Utf8Validation) {
	/**
	* @generated from enum value: UTF8_VALIDATION_UNKNOWN = 0;
	*/
	FeatureSet_Utf8Validation[FeatureSet_Utf8Validation["UTF8_VALIDATION_UNKNOWN"] = 0] = "UTF8_VALIDATION_UNKNOWN";
	/**
	* @generated from enum value: VERIFY = 2;
	*/
	FeatureSet_Utf8Validation[FeatureSet_Utf8Validation["VERIFY"] = 2] = "VERIFY";
	/**
	* @generated from enum value: NONE = 3;
	*/
	FeatureSet_Utf8Validation[FeatureSet_Utf8Validation["NONE"] = 3] = "NONE";
})(FeatureSet_Utf8Validation || (FeatureSet_Utf8Validation = {}));
/**
* @generated from enum google.protobuf.FeatureSet.MessageEncoding
*/
var FeatureSet_MessageEncoding;
(function(FeatureSet_MessageEncoding) {
	/**
	* @generated from enum value: MESSAGE_ENCODING_UNKNOWN = 0;
	*/
	FeatureSet_MessageEncoding[FeatureSet_MessageEncoding["MESSAGE_ENCODING_UNKNOWN"] = 0] = "MESSAGE_ENCODING_UNKNOWN";
	/**
	* @generated from enum value: LENGTH_PREFIXED = 1;
	*/
	FeatureSet_MessageEncoding[FeatureSet_MessageEncoding["LENGTH_PREFIXED"] = 1] = "LENGTH_PREFIXED";
	/**
	* @generated from enum value: DELIMITED = 2;
	*/
	FeatureSet_MessageEncoding[FeatureSet_MessageEncoding["DELIMITED"] = 2] = "DELIMITED";
})(FeatureSet_MessageEncoding || (FeatureSet_MessageEncoding = {}));
/**
* @generated from enum google.protobuf.FeatureSet.JsonFormat
*/
var FeatureSet_JsonFormat;
(function(FeatureSet_JsonFormat) {
	/**
	* @generated from enum value: JSON_FORMAT_UNKNOWN = 0;
	*/
	FeatureSet_JsonFormat[FeatureSet_JsonFormat["JSON_FORMAT_UNKNOWN"] = 0] = "JSON_FORMAT_UNKNOWN";
	/**
	* @generated from enum value: ALLOW = 1;
	*/
	FeatureSet_JsonFormat[FeatureSet_JsonFormat["ALLOW"] = 1] = "ALLOW";
	/**
	* @generated from enum value: LEGACY_BEST_EFFORT = 2;
	*/
	FeatureSet_JsonFormat[FeatureSet_JsonFormat["LEGACY_BEST_EFFORT"] = 2] = "LEGACY_BEST_EFFORT";
})(FeatureSet_JsonFormat || (FeatureSet_JsonFormat = {}));
/**
* @generated from enum google.protobuf.FeatureSet.EnforceNamingStyle
*/
var FeatureSet_EnforceNamingStyle;
(function(FeatureSet_EnforceNamingStyle) {
	/**
	* @generated from enum value: ENFORCE_NAMING_STYLE_UNKNOWN = 0;
	*/
	FeatureSet_EnforceNamingStyle[FeatureSet_EnforceNamingStyle["ENFORCE_NAMING_STYLE_UNKNOWN"] = 0] = "ENFORCE_NAMING_STYLE_UNKNOWN";
	/**
	* @generated from enum value: STYLE2024 = 1;
	*/
	FeatureSet_EnforceNamingStyle[FeatureSet_EnforceNamingStyle["STYLE2024"] = 1] = "STYLE2024";
	/**
	* @generated from enum value: STYLE_LEGACY = 2;
	*/
	FeatureSet_EnforceNamingStyle[FeatureSet_EnforceNamingStyle["STYLE_LEGACY"] = 2] = "STYLE_LEGACY";
})(FeatureSet_EnforceNamingStyle || (FeatureSet_EnforceNamingStyle = {}));
/**
* Represents the identified object's effect on the element in the original
* .proto file.
*
* @generated from enum google.protobuf.GeneratedCodeInfo.Annotation.Semantic
*/
var GeneratedCodeInfo_Annotation_Semantic;
(function(GeneratedCodeInfo_Annotation_Semantic) {
	/**
	* There is no effect or the effect is indescribable.
	*
	* @generated from enum value: NONE = 0;
	*/
	GeneratedCodeInfo_Annotation_Semantic[GeneratedCodeInfo_Annotation_Semantic["NONE"] = 0] = "NONE";
	/**
	* The element is set or otherwise mutated.
	*
	* @generated from enum value: SET = 1;
	*/
	GeneratedCodeInfo_Annotation_Semantic[GeneratedCodeInfo_Annotation_Semantic["SET"] = 1] = "SET";
	/**
	* An alias to the element is returned.
	*
	* @generated from enum value: ALIAS = 2;
	*/
	GeneratedCodeInfo_Annotation_Semantic[GeneratedCodeInfo_Annotation_Semantic["ALIAS"] = 2] = "ALIAS";
})(GeneratedCodeInfo_Annotation_Semantic || (GeneratedCodeInfo_Annotation_Semantic = {}));
/**
* The full set of known editions.
*
* @generated from enum google.protobuf.Edition
*/
var Edition;
(function(Edition) {
	/**
	* A placeholder for an unknown edition value.
	*
	* @generated from enum value: EDITION_UNKNOWN = 0;
	*/
	Edition[Edition["EDITION_UNKNOWN"] = 0] = "EDITION_UNKNOWN";
	/**
	* A placeholder edition for specifying default behaviors *before* a feature
	* was first introduced.  This is effectively an "infinite past".
	*
	* @generated from enum value: EDITION_LEGACY = 900;
	*/
	Edition[Edition["EDITION_LEGACY"] = 900] = "EDITION_LEGACY";
	/**
	* Legacy syntax "editions".  These pre-date editions, but behave much like
	* distinct editions.  These can't be used to specify the edition of proto
	* files, but feature definitions must supply proto2/proto3 defaults for
	* backwards compatibility.
	*
	* @generated from enum value: EDITION_PROTO2 = 998;
	*/
	Edition[Edition["EDITION_PROTO2"] = 998] = "EDITION_PROTO2";
	/**
	* @generated from enum value: EDITION_PROTO3 = 999;
	*/
	Edition[Edition["EDITION_PROTO3"] = 999] = "EDITION_PROTO3";
	/**
	* Editions that have been released.  The specific values are arbitrary and
	* should not be depended on, but they will always be time-ordered for easy
	* comparison.
	*
	* @generated from enum value: EDITION_2023 = 1000;
	*/
	Edition[Edition["EDITION_2023"] = 1e3] = "EDITION_2023";
	/**
	* @generated from enum value: EDITION_2024 = 1001;
	*/
	Edition[Edition["EDITION_2024"] = 1001] = "EDITION_2024";
	/**
	* A placeholder edition for developing and testing unscheduled features.
	*
	* @generated from enum value: EDITION_UNSTABLE = 9999;
	*/
	Edition[Edition["EDITION_UNSTABLE"] = 9999] = "EDITION_UNSTABLE";
	/**
	* Placeholder editions for testing feature resolution.  These should not be
	* used or relied on outside of tests.
	*
	* @generated from enum value: EDITION_1_TEST_ONLY = 1;
	*/
	Edition[Edition["EDITION_1_TEST_ONLY"] = 1] = "EDITION_1_TEST_ONLY";
	/**
	* @generated from enum value: EDITION_2_TEST_ONLY = 2;
	*/
	Edition[Edition["EDITION_2_TEST_ONLY"] = 2] = "EDITION_2_TEST_ONLY";
	/**
	* @generated from enum value: EDITION_99997_TEST_ONLY = 99997;
	*/
	Edition[Edition["EDITION_99997_TEST_ONLY"] = 99997] = "EDITION_99997_TEST_ONLY";
	/**
	* @generated from enum value: EDITION_99998_TEST_ONLY = 99998;
	*/
	Edition[Edition["EDITION_99998_TEST_ONLY"] = 99998] = "EDITION_99998_TEST_ONLY";
	/**
	* @generated from enum value: EDITION_99999_TEST_ONLY = 99999;
	*/
	Edition[Edition["EDITION_99999_TEST_ONLY"] = 99999] = "EDITION_99999_TEST_ONLY";
	/**
	* Placeholder for specifying unbounded edition support.  This should only
	* ever be used by plugins that can expect to never require any changes to
	* support a new edition.
	*
	* @generated from enum value: EDITION_MAX = 2147483647;
	*/
	Edition[Edition["EDITION_MAX"] = 2147483647] = "EDITION_MAX";
})(Edition || (Edition = {}));
/**
* Describes the 'visibility' of a symbol with respect to the proto import
* system. Symbols can only be imported when the visibility rules do not prevent
* it (ex: local symbols cannot be imported).  Visibility modifiers can only set
* on `message` and `enum` as they are the only types available to be referenced
* from other files.
*
* @generated from enum google.protobuf.SymbolVisibility
*/
var SymbolVisibility;
(function(SymbolVisibility) {
	/**
	* @generated from enum value: VISIBILITY_UNSET = 0;
	*/
	SymbolVisibility[SymbolVisibility["VISIBILITY_UNSET"] = 0] = "VISIBILITY_UNSET";
	/**
	* @generated from enum value: VISIBILITY_LOCAL = 1;
	*/
	SymbolVisibility[SymbolVisibility["VISIBILITY_LOCAL"] = 1] = "VISIBILITY_LOCAL";
	/**
	* @generated from enum value: VISIBILITY_EXPORT = 2;
	*/
	SymbolVisibility[SymbolVisibility["VISIBILITY_EXPORT"] = 2] = "VISIBILITY_EXPORT";
})(SymbolVisibility || (SymbolVisibility = {}));
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/from-binary.js
var readDefaults = { readUnknownFields: true };
function makeReadOptions(options) {
	return options ? Object.assign(Object.assign({}, readDefaults), options) : readDefaults;
}
/**
* Parse serialized binary data.
*/
function fromBinary(schema, bytes, options) {
	const msg = reflect(schema, void 0, false);
	readMessage(msg, new BinaryReader(bytes), makeReadOptions(options), false, bytes.byteLength);
	return msg.message;
}
/**
* If `delimited` is false, read the length given in `lengthOrDelimitedFieldNo`.
*
* If `delimited` is true, read until an EndGroup tag. `lengthOrDelimitedFieldNo`
* is the expected field number.
*
* @private
*/
function readMessage(message, reader, options, delimited, lengthOrDelimitedFieldNo) {
	var _a;
	const end = delimited ? reader.len : reader.pos + lengthOrDelimitedFieldNo;
	let fieldNo;
	let wireType;
	const unknownFields = (_a = message.getUnknown()) !== null && _a !== void 0 ? _a : [];
	while (reader.pos < end) {
		[fieldNo, wireType] = reader.tag();
		if (delimited && wireType == WireType.EndGroup) break;
		const field = message.findNumber(fieldNo);
		if (!field) {
			const data = reader.skip(wireType, fieldNo);
			if (options.readUnknownFields) unknownFields.push({
				no: fieldNo,
				wireType,
				data
			});
			continue;
		}
		readField(message, reader, field, wireType, options);
	}
	if (delimited) {
		if (wireType != WireType.EndGroup || fieldNo !== lengthOrDelimitedFieldNo) throw new Error("invalid end group tag");
	}
	if (unknownFields.length > 0) message.setUnknown(unknownFields);
}
/**
* @private
*/
function readField(message, reader, field, wireType, options) {
	var _a;
	switch (field.fieldKind) {
		case "scalar":
			message.set(field, readScalar(reader, field.scalar));
			break;
		case "enum":
			const val = readScalar(reader, ScalarType.INT32);
			if (field.enum.open) message.set(field, val);
			else if (field.enum.values.some((v) => v.number === val)) message.set(field, val);
			else if (options.readUnknownFields) {
				const bytes = [];
				varint32write(val, bytes);
				const unknownFields = (_a = message.getUnknown()) !== null && _a !== void 0 ? _a : [];
				unknownFields.push({
					no: field.number,
					wireType,
					data: new Uint8Array(bytes)
				});
				message.setUnknown(unknownFields);
			}
			break;
		case "message":
			message.set(field, readMessageField(reader, options, field, message.get(field)));
			break;
		case "list":
			readListField(reader, wireType, message.get(field), options);
			break;
		case "map":
			readMapEntry(reader, message.get(field), options);
			break;
	}
}
function readMapEntry(reader, map, options) {
	const field = map.field();
	let key;
	let val;
	const len = reader.uint32();
	const end = reader.pos + len;
	while (reader.pos < end) {
		const [fieldNo] = reader.tag();
		switch (fieldNo) {
			case 1:
				key = readScalar(reader, field.mapKey);
				break;
			case 2:
				switch (field.mapKind) {
					case "scalar":
						val = readScalar(reader, field.scalar);
						break;
					case "enum":
						val = reader.int32();
						break;
					case "message":
						val = readMessageField(reader, options, field);
						break;
				}
				break;
		}
	}
	if (key === void 0) key = scalarZeroValue(field.mapKey, false);
	if (val === void 0) switch (field.mapKind) {
		case "scalar":
			val = scalarZeroValue(field.scalar, false);
			break;
		case "enum":
			val = field.enum.values[0].number;
			break;
		case "message":
			val = reflect(field.message, void 0, false);
			break;
	}
	map.set(key, val);
}
function readListField(reader, wireType, list, options) {
	var _a;
	const field = list.field();
	if (field.listKind === "message") {
		list.add(readMessageField(reader, options, field));
		return;
	}
	const scalarType = (_a = field.scalar) !== null && _a !== void 0 ? _a : ScalarType.INT32;
	if (!(wireType == WireType.LengthDelimited && scalarType != ScalarType.STRING && scalarType != ScalarType.BYTES)) {
		list.add(readScalar(reader, scalarType));
		return;
	}
	const e = reader.uint32() + reader.pos;
	while (reader.pos < e) list.add(readScalar(reader, scalarType));
}
function readMessageField(reader, options, field, mergeMessage) {
	const delimited = field.delimitedEncoding;
	const message = mergeMessage !== null && mergeMessage !== void 0 ? mergeMessage : reflect(field.message, void 0, false);
	readMessage(message, reader, options, delimited, delimited ? field.number : reader.uint32());
	return message;
}
function readScalar(reader, type) {
	switch (type) {
		case ScalarType.STRING: return reader.string();
		case ScalarType.BOOL: return reader.bool();
		case ScalarType.DOUBLE: return reader.double();
		case ScalarType.FLOAT: return reader.float();
		case ScalarType.INT32: return reader.int32();
		case ScalarType.INT64: return reader.int64();
		case ScalarType.UINT64: return reader.uint64();
		case ScalarType.FIXED64: return reader.fixed64();
		case ScalarType.BYTES: return reader.bytes();
		case ScalarType.FIXED32: return reader.fixed32();
		case ScalarType.SFIXED32: return reader.sfixed32();
		case ScalarType.SFIXED64: return reader.sfixed64();
		case ScalarType.SINT64: return reader.sint64();
		case ScalarType.UINT32: return reader.uint32();
		case ScalarType.SINT32: return reader.sint32();
	}
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/codegenv2/file.js
/**
* Hydrate a file descriptor.
*
* @private
*/
function fileDesc(b64, imports) {
	var _a;
	const root = fromBinary(FileDescriptorProtoSchema, base64Decode(b64));
	root.messageType.forEach(restoreJsonNames);
	root.dependency = (_a = imports === null || imports === void 0 ? void 0 : imports.map((f) => f.proto.name)) !== null && _a !== void 0 ? _a : [];
	return createFileRegistry(root, (protoFileName) => imports === null || imports === void 0 ? void 0 : imports.find((f) => f.proto.name === protoFileName)).getFile(root.name);
}
//#endregion
export { ScalarType as S, isFieldError as _, messageDesc as a, scalarZeroValue as b, base64Decode as c, checkField as d, formatVal as f, FieldError as g, WireType as h, MethodOptions_IdempotencyLevel as i, base64Encode as l, BinaryWriter as m, fromBinary as n, protoCamelCase as o, BinaryReader as p, readField as r, protoSnakeCase as s, fileDesc as t, reflect as u, create as v, protoInt64 as x, isWrapperDesc as y };
