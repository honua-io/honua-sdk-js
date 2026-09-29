import { A as isReflectMessage, B as isMessage, C as create, D as isObject, E as isWrapperDesc, F as unsafeOneofCase, I as unsafeSet, L as scalarZeroValue, M as unsafeGet, N as unsafeIsSet, O as isReflectList, P as unsafeLocal, R as protoInt64, S as getTextEncoding, T as isWrapper, a as MethodOptions_IdempotencyLevel, c as protoSnakeCase, d as localMessageMapper, f as wktStructToLocal, h as BinaryWriter, i as readField, j as unsafeClear, k as isReflectMap, l as base64Decode, m as BinaryReader, n as fromBinary, o as messageDesc, p as wktStructToReflect, r as makeReadContext$1, s as protoCamelCase, t as fileDesc, u as base64Encode, w as hasCustomJsonRepresentation, x as WireType, z as ScalarType } from "./file-Desv2rc0.js";
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
	const checkKey = checkScalarValue(field.mapKey)(key);
	if (checkKey !== true) return new FieldError(field, `invalid map key: ${reasonSingular({ scalar: field.mapKey }, key, checkKey)}`);
	const checkVal = checkSingular(field, value);
	if (checkVal !== true) return new FieldError(field, `map entry ${formatVal(key)}: ${reasonSingular(field, value, checkVal)}`);
}
function checkSingular(field, value) {
	if (field.scalar !== void 0) return checkScalarValue(field.scalar)(value);
	if (field.enum !== void 0) {
		if (field.enum.open) return checkScalarValue(ScalarType.INT32)(value);
		return field.enum.values.some((v) => v.number === value);
	}
	return isReflectMessage(value, field.message);
}
/**
* Return the check for values of the given scalar type.
*
* @private
*/
function checkScalarValue(scalar) {
	switch (scalar) {
		case ScalarType.DOUBLE: return (value) => typeof value == "number";
		case ScalarType.FLOAT: return (value) => {
			if (typeof value != "number") return false;
			if (Number.isNaN(value) || !Number.isFinite(value)) return true;
			if (value > 34028234663852886e22 || value < -34028234663852886e22) return `${value.toFixed()} out of range`;
			return true;
		};
		case ScalarType.INT32:
		case ScalarType.SFIXED32:
		case ScalarType.SINT32: return (value) => {
			if (typeof value !== "number" || !Number.isInteger(value)) return false;
			if (value > 2147483647 || value < -2147483648) return `${value.toFixed()} out of range`;
			return true;
		};
		case ScalarType.FIXED32:
		case ScalarType.UINT32: return (value) => {
			if (typeof value !== "number" || !Number.isInteger(value)) return false;
			if (value > 4294967295 || value < 0) return `${value.toFixed()} out of range`;
			return true;
		};
		case ScalarType.BOOL: return (value) => typeof value == "boolean";
		case ScalarType.STRING: return (value) => {
			if (typeof value != "string") return false;
			return getTextEncoding().checkUtf8(value) || "invalid UTF8";
		};
		case ScalarType.BYTES: return (value) => value instanceof Uint8Array;
		case ScalarType.INT64:
		case ScalarType.SFIXED64:
		case ScalarType.SINT64: return (value) => {
			if (typeof value == "bigint" || typeof value == "number" || typeof value == "string" && value.length > 0) try {
				protoInt64.parse(value);
				return true;
			} catch (_) {
				return `${value} out of range`;
			}
			return false;
		};
		case ScalarType.FIXED64:
		case ScalarType.UINT64: return (value) => {
			if (typeof value == "bigint" || typeof value == "number" || typeof value == "string" && value.length > 0) try {
				protoInt64.uParse(value);
				return true;
			} catch (_) {
				return `${value} out of range`;
			}
			return false;
		};
	}
}
/**
* Format the reason why a value is invalid for a singular field.
*
* @private
*/
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
		default: try {
			return protoInt64.parse(key);
		} catch (_b) {}
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
		case ScalarType.UINT64: if ("longAsString" in field && field.longAsString && typeof value == "string") value = protoInt64.uParse(value);
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
		case ScalarType.UINT64: if ("longAsString" in field && field.longAsString) value = String(value);
		else if (typeof value == "string" || typeof value == "number") value = protoInt64.uParse(value);
	}
	return value;
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/wkt/gen/google/protobuf/any_pb.js
/**
* Describes the file google/protobuf/any.proto.
*/
var file_google_protobuf_any = /*@__PURE__*/ fileDesc("Chlnb29nbGUvcHJvdG9idWYvYW55LnByb3RvEg9nb29nbGUucHJvdG9idWYiJgoDQW55EhAKCHR5cGVfdXJsGAEgASgJEg0KBXZhbHVlGAIgASgMQnYKE2NvbS5nb29nbGUucHJvdG9idWZCCEFueVByb3RvUAFaLGdvb2dsZS5nb2xhbmcub3JnL3Byb3RvYnVmL3R5cGVzL2tub3duL2FueXBiogIDR1BCqgIeR29vZ2xlLlByb3RvYnVmLldlbGxLbm93blR5cGVzYgZwcm90bzM");
/**
* Describes the message google.protobuf.Any.
* Use `create(AnySchema)` to create a new message.
*/
var AnySchema = /*@__PURE__*/ messageDesc(file_google_protobuf_any, 0);
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/to-binary.js
var IMPLICIT$2 = 2;
var LEGACY_REQUIRED$1 = 3;
var writeDefaults = { writeUnknownFields: true };
function makeWriteOptions$1(options) {
	return options ? Object.assign(Object.assign({}, writeDefaults), options) : writeDefaults;
}
function toBinary(schema, message, options) {
	const writer = new BinaryWriter();
	compiledWriter$1(schema)(writer, makeWriteOptions$1(options), message);
	return writer.finish();
}
var compiledWriters$1 = /* @__PURE__ */ new WeakMap();
/**
* Return the compiled encoder for a message, compiling it on first use.
*/
function compiledWriter$1(desc) {
	let compiled = compiledWriters$1.get(desc);
	if (compiled === void 0) compiled = compileMessage$2(desc);
	return compiled;
}
function compileMessage$2(desc) {
	const typeName = desc.typeName;
	const sortedFields = desc.fields.concat().sort((a, b) => a.number - b.number);
	const foreignField = sortedFields[0];
	const fieldWriters = [];
	const compiled = (writer, opts, message) => {
		if (message.$typeName !== typeName && foreignField !== void 0) throw new FieldError(foreignField, `cannot use ${foreignField} with message ${message.$typeName}`, "ForeignFieldError");
		for (let i = 0; i < fieldWriters.length; i++) fieldWriters[i](writer, opts, message);
		const unknown = message.$unknown;
		if (unknown !== void 0 && opts.writeUnknownFields) for (let i = 0; i < unknown.length; i++) {
			const { no, wireType, data } = unknown[i];
			writer.tag(no, wireType).raw(data);
		}
	};
	compiledWriters$1.set(desc, compiled);
	for (const field of sortedFields) fieldWriters.push(compileField$1(field));
	return compiled;
}
function compileField$1(field) {
	switch (field.fieldKind) {
		case "message":
		case "scalar":
		case "enum": return compileSingularField$1(field);
		case "list": return compileListField(field);
		case "map": return compileMapField(field);
	}
}
/**
* Compile an encoder for a singular field: the presence check, and the
* value encoder.
*/
function compileSingularField$1(field) {
	const writeValue = compileSingularValue$1(field);
	const localName = field.localName;
	if (field.oneof) {
		const oneofLocalName = field.oneof.localName;
		return (writer, opts, message) => {
			const oneof = message[oneofLocalName];
			if (oneof.case === localName) writeValue(writer, opts, oneof.value);
		};
	}
	if (field.presence != IMPLICIT$2) {
		const requiredError = field.presence == LEGACY_REQUIRED$1 ? `cannot encode ${field} to binary: required field not set` : void 0;
		return (writer, opts, message) => {
			const value = message[localName];
			if (value !== void 0 && Object.prototype.hasOwnProperty.call(message, localName)) writeValue(writer, opts, value);
			else if (requiredError !== void 0) throw new Error(requiredError);
		};
	}
	if (field.fieldKind == "enum") {
		const zero = field.enum.values[0].number;
		return (writer, opts, message) => {
			const value = message[localName];
			if (value !== zero) writeValue(writer, opts, value);
		};
	}
	switch (field.scalar) {
		case ScalarType.BOOL: return (writer, opts, message) => {
			const value = message[localName];
			if (value !== false) writeValue(writer, opts, value);
		};
		case ScalarType.STRING: return (writer, opts, message) => {
			const value = message[localName];
			if (value !== "") writeValue(writer, opts, value);
		};
		case ScalarType.BYTES: return (writer, opts, message) => {
			const value = message[localName];
			if (!(value instanceof Uint8Array) || value.byteLength > 0) writeValue(writer, opts, value);
		};
		case ScalarType.DOUBLE:
		case ScalarType.FLOAT: return (writer, opts, message) => {
			const value = message[localName];
			if (!Object.is(value, 0)) writeValue(writer, opts, value);
		};
		default: return (writer, opts, message) => {
			const value = message[localName];
			if (value != 0) writeValue(writer, opts, value);
		};
	}
}
/**
* Compile an encoder for the value of a singular field, including the tag.
*/
function compileSingularValue$1(field) {
	switch (field.fieldKind) {
		case "message": {
			const { toMessage } = localMessageMapper(field);
			const writeChild = compileChildWriter(field);
			return (writer, opts, value) => {
				writeChild(writer, opts, toMessage(value));
			};
		}
		case "scalar":
		case "enum": {
			const scalarType = field.fieldKind == "enum" ? ScalarType.INT32 : field.scalar;
			const fieldNo = field.number;
			const wireType = writeTypeOfScalar(scalarType);
			const writeScalar = compileScalarValue$1(scalarType, field.parent.typeName, field.name);
			return (writer, opts, value) => {
				writer.tag(fieldNo, wireType);
				writeScalar(writer, value);
			};
		}
	}
}
function compileListField(field) {
	const localName = field.localName;
	const fieldNo = field.number;
	switch (field.listKind) {
		case "message": {
			const { toMessage } = localMessageMapper(field);
			const writeChild = compileChildWriter(field);
			return (writer, opts, message) => {
				const items = message[localName];
				for (let i = 0; i < items.length; i++) writeChild(writer, opts, toMessage(items[i]));
			};
		}
		case "scalar":
		case "enum": {
			const scalarType = field.listKind == "enum" ? ScalarType.INT32 : field.scalar;
			const writeScalar = compileScalarValue$1(scalarType, field.parent.typeName, field.name);
			if (field.packed) return (writer, opts, message) => {
				const items = message[localName];
				if (items.length == 0) return;
				writer.tag(fieldNo, WireType.LengthDelimited).fork();
				for (let i = 0; i < items.length; i++) writeScalar(writer, items[i]);
				writer.join();
			};
			const wireType = writeTypeOfScalar(scalarType);
			return (writer, opts, message) => {
				const items = message[localName];
				for (let i = 0; i < items.length; i++) {
					writer.tag(fieldNo, wireType);
					writeScalar(writer, items[i]);
				}
			};
		}
	}
}
function compileMapField(field) {
	const localName = field.localName;
	const fieldNo = field.number;
	const writeKey = compileMapKey(field);
	if (field.mapKind == "message") {
		const { toMessage } = localMessageMapper(field);
		const writeMessage = compiledWriter$1(field.message);
		return (writer, opts, message) => {
			const record = message[localName];
			const keys = Object.keys(record);
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i];
				writer.tag(fieldNo, WireType.LengthDelimited).fork();
				writeKey(writer, key);
				writer.tag(2, WireType.LengthDelimited).fork();
				writeMessage(writer, opts, toMessage(record[key]));
				writer.join();
				writer.join();
			}
		};
	}
	const scalarType = field.mapKind == "enum" ? ScalarType.INT32 : field.scalar;
	const valueWireType = writeTypeOfScalar(scalarType);
	const writeScalar = compileScalarValue$1(scalarType, field.parent.typeName, field.name);
	return (writer, opts, message) => {
		const record = message[localName];
		const keys = Object.keys(record);
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			writer.tag(fieldNo, WireType.LengthDelimited).fork();
			writeKey(writer, key);
			writer.tag(2, valueWireType);
			writeScalar(writer, record[key]);
			writer.join();
		}
	};
}
/**
* Compile an encoder for a map key. Map keys are stored as object keys and
* are always strings locally. Convert them to their scalar type before
* writing, like the reflect API does when iterating map entries.
*/
function compileMapKey(field) {
	const wireType = writeTypeOfScalar(field.mapKey);
	const writeScalar = compileScalarValue$1(field.mapKey, field.parent.typeName, field.name);
	const convertKey = compileMapKeyConverter(field.mapKey);
	return (writer, key) => {
		writer.tag(1, wireType);
		writeScalar(writer, convertKey(key));
	};
}
/**
* Returns a converter from an object key (always a string) to the closest
* possible type for the map key type. Invalid keys are passed through to
* the scalar writer, which raises an error for them.
*/
function compileMapKeyConverter(type) {
	switch (type) {
		case ScalarType.STRING: return (key) => key;
		case ScalarType.BOOL: return (key) => key === "true" ? true : key === "false" ? false : key;
		case ScalarType.UINT64:
		case ScalarType.FIXED64: return (key) => {
			try {
				return protoInt64.uParse(key);
			} catch (_a) {
				return key;
			}
		};
		case ScalarType.INT64:
		case ScalarType.SFIXED64:
		case ScalarType.SINT64: return (key) => {
			try {
				return protoInt64.parse(key);
			} catch (_a) {
				return key;
			}
		};
		default: return (key) => {
			const n = Number.parseInt(key);
			return Number.isFinite(n) ? n : key;
		};
	}
}
/**
* Compile an encoder for a bare scalar value (no tag), wrapping errors from
* the writer with the message and field name.
*/
function compileScalarValue$1(type, messageName, fieldName) {
	const writeScalar = compileScalarWrite(type);
	return (writer, value) => {
		try {
			writeScalar(writer, value);
		} catch (e) {
			if (e instanceof Error) throw new Error(`cannot encode field ${messageName}.${fieldName} to binary: ${e.message}`);
			throw e;
		}
	};
}
function compileScalarWrite(type) {
	switch (type) {
		case ScalarType.STRING: return (writer, value) => writer.string(value);
		case ScalarType.BOOL: return (writer, value) => writer.bool(value);
		case ScalarType.DOUBLE: return (writer, value) => writer.double(value);
		case ScalarType.FLOAT: return (writer, value) => writer.float(value);
		case ScalarType.INT32: return (writer, value) => writer.int32(value);
		case ScalarType.INT64: return (writer, value) => writer.int64(value);
		case ScalarType.UINT64: return (writer, value) => writer.uint64(value);
		case ScalarType.FIXED64: return (writer, value) => writer.fixed64(value);
		case ScalarType.BYTES: return (writer, value) => writer.bytes(value);
		case ScalarType.FIXED32: return (writer, value) => writer.fixed32(value);
		case ScalarType.SFIXED32: return (writer, value) => writer.sfixed32(value);
		case ScalarType.SFIXED64: return (writer, value) => writer.sfixed64(value);
		case ScalarType.SINT64: return (writer, value) => writer.sint64(value);
		case ScalarType.UINT32: return (writer, value) => writer.uint32(value);
		case ScalarType.SINT32: return (writer, value) => writer.sint32(value);
	}
}
/**
* Write a single field to binary format, if it is set. Used to serialize
* extensions: extensions always have explicit presence, so an extension
* value that was just set on the container is always written.
*
* @private
*/
function writeField(writer, opts, msg, field) {
	compileField$1(field)(writer, opts, msg[unsafeLocal]);
}
/**
* Compile an encoder for the wire format of a message field, honoring the
* delimited encoding of the field. The tag is written by the encoder.
*/
function compileChildWriter(field) {
	const fieldNo = field.number;
	const writeMessage = compiledWriter$1(field.message);
	if (field.delimitedEncoding) return (writer, opts, child) => {
		writer.tag(fieldNo, WireType.StartGroup);
		writeMessage(writer, opts, child);
		writer.tag(fieldNo, WireType.EndGroup);
	};
	return (writer, opts, child) => {
		writer.tag(fieldNo, WireType.LengthDelimited).fork();
		writeMessage(writer, opts, child);
		writer.join();
	};
}
function writeTypeOfScalar(type) {
	switch (type) {
		case ScalarType.BYTES:
		case ScalarType.STRING: return WireType.LengthDelimited;
		case ScalarType.DOUBLE:
		case ScalarType.FIXED64:
		case ScalarType.SFIXED64: return WireType.Bit64;
		case ScalarType.FIXED32:
		case ScalarType.SFIXED32:
		case ScalarType.FLOAT: return WireType.Bit32;
		default: return WireType.Varint;
	}
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/wkt/any.js
function anyPack(schema, message, into) {
	let ret = false;
	if (!into) {
		into = create(AnySchema);
		ret = true;
	}
	into.value = toBinary(schema, message);
	into.typeUrl = typeNameToUrl(message.$typeName);
	return ret ? into : void 0;
}
function anyIs(any, descOrTypeName) {
	if (any.typeUrl === "") return false;
	return (typeof descOrTypeName == "string" ? descOrTypeName : descOrTypeName.typeName) === typeUrlToName(any.typeUrl);
}
function anyUnpack(any, registryOrMessageDesc) {
	if (any.typeUrl === "") return;
	const desc = registryOrMessageDesc.kind == "message" ? registryOrMessageDesc : registryOrMessageDesc.getMessage(typeUrlToName(any.typeUrl));
	if (!desc || !anyIs(any, desc)) return;
	return fromBinary(desc, any.value);
}
function typeNameToUrl(name) {
	return `type.googleapis.com/${name}`;
}
function typeUrlToName(url) {
	const slash = url.lastIndexOf("/");
	const name = slash >= 0 ? url.substring(slash + 1) : url;
	if (!name.length) throw new Error(`invalid type url: ${url}`);
	return name;
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/wkt/gen/google/protobuf/struct_pb.js
/**
* Describes the file google/protobuf/struct.proto.
*/
var file_google_protobuf_struct = /*@__PURE__*/ fileDesc("Chxnb29nbGUvcHJvdG9idWYvc3RydWN0LnByb3RvEg9nb29nbGUucHJvdG9idWYihAEKBlN0cnVjdBIzCgZmaWVsZHMYASADKAsyIy5nb29nbGUucHJvdG9idWYuU3RydWN0LkZpZWxkc0VudHJ5GkUKC0ZpZWxkc0VudHJ5EgsKA2tleRgBIAEoCRIlCgV2YWx1ZRgCIAEoCzIWLmdvb2dsZS5wcm90b2J1Zi5WYWx1ZToCOAEi6gEKBVZhbHVlEjAKCm51bGxfdmFsdWUYASABKA4yGi5nb29nbGUucHJvdG9idWYuTnVsbFZhbHVlSAASFgoMbnVtYmVyX3ZhbHVlGAIgASgBSAASFgoMc3RyaW5nX3ZhbHVlGAMgASgJSAASFAoKYm9vbF92YWx1ZRgEIAEoCEgAEi8KDHN0cnVjdF92YWx1ZRgFIAEoCzIXLmdvb2dsZS5wcm90b2J1Zi5TdHJ1Y3RIABIwCgpsaXN0X3ZhbHVlGAYgASgLMhouZ29vZ2xlLnByb3RvYnVmLkxpc3RWYWx1ZUgAQgYKBGtpbmQiMwoJTGlzdFZhbHVlEiYKBnZhbHVlcxgBIAMoCzIWLmdvb2dsZS5wcm90b2J1Zi5WYWx1ZSobCglOdWxsVmFsdWUSDgoKTlVMTF9WQUxVRRAAQn8KE2NvbS5nb29nbGUucHJvdG9idWZCC1N0cnVjdFByb3RvUAFaL2dvb2dsZS5nb2xhbmcub3JnL3Byb3RvYnVmL3R5cGVzL2tub3duL3N0cnVjdHBi+AEBogIDR1BCqgIeR29vZ2xlLlByb3RvYnVmLldlbGxLbm93blR5cGVzYgZwcm90bzM");
/**
* Describes the message google.protobuf.Struct.
* Use `create(StructSchema)` to create a new message.
*/
var StructSchema = /*@__PURE__*/ messageDesc(file_google_protobuf_struct, 0);
/**
* Describes the message google.protobuf.Value.
* Use `create(ValueSchema)` to create a new message.
*/
var ValueSchema = /*@__PURE__*/ messageDesc(file_google_protobuf_struct, 1);
/**
* Describes the message google.protobuf.ListValue.
* Use `create(ListValueSchema)` to create a new message.
*/
var ListValueSchema = /*@__PURE__*/ messageDesc(file_google_protobuf_struct, 2);
/**
* `NullValue` is a singleton enumeration to represent the null value for the
* `Value` type union.
*
* The JSON representation for `NullValue` is JSON `null`.
*
* @generated from enum google.protobuf.NullValue
*/
var NullValue;
(function(NullValue) {
	/**
	* Null value.
	*
	* @generated from enum value: NULL_VALUE = 0;
	*/
	NullValue[NullValue["NULL_VALUE"] = 0] = "NULL_VALUE";
})(NullValue || (NullValue = {}));
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/extensions.js
/**
* Retrieve an extension value from a message.
*
* The function never returns undefined. Use hasExtension() to check whether an
* extension is set. If the extension is not set, this function returns the
* default value (if one was specified in the protobuf source), or the zero value
* (for example `0` for numeric types, `[]` for repeated extension fields, and
* an empty message instance for message fields).
*
* Extensions are stored as unknown fields on a message. To mutate an extension
* value, make sure to store the new value with setExtension() after mutating.
*
* If the extension does not extend the given message, an error is raised.
*/
function getExtension(message, extension, options) {
	assertExtendee(extension, message);
	const ufs = filterUnknownFields(message.$unknown, extension);
	const [container, field, get] = createExtensionContainer(extension);
	const ctx = makeReadContext$1(options);
	for (const uf of ufs) readField(container, new BinaryReader(uf.data), field, uf.wireType, ctx);
	return get();
}
/**
* Set an extension value on a message. If the message already has a value for
* this extension, the value is replaced.
*
* If the extension does not extend the given message, an error is raised.
*/
function setExtension(message, extension, value) {
	var _a;
	assertExtendee(extension, message);
	const ufs = ((_a = message.$unknown) !== null && _a !== void 0 ? _a : []).filter((uf) => uf.no !== extension.number);
	const [container, field] = createExtensionContainer(extension, value);
	const writer = new BinaryWriter();
	writeField(writer, { writeUnknownFields: true }, container, field);
	const reader = new BinaryReader(writer.finish());
	while (reader.pos < reader.len) {
		const [no, wireType] = reader.tag();
		const data = reader.skip(wireType, no);
		ufs.push({
			no,
			wireType,
			data
		});
	}
	message.$unknown = ufs;
}
function filterUnknownFields(unknownFields, extension) {
	if (unknownFields === void 0) return [];
	if (extension.fieldKind === "enum" || extension.fieldKind === "scalar") {
		for (let i = unknownFields.length - 1; i >= 0; --i) if (unknownFields[i].no == extension.number) return [unknownFields[i]];
		return [];
	}
	return unknownFields.filter((uf) => uf.no === extension.number);
}
/**
* @private
*/
function createExtensionContainer(extension, value) {
	const localName = extension.typeName;
	const field = Object.assign(Object.assign({}, extension), {
		kind: "field",
		parent: extension.extendee,
		localName
	});
	const desc = Object.assign(Object.assign({}, extension.extendee), {
		fields: [field],
		members: [field],
		oneofs: []
	});
	const container = create(desc, value !== void 0 ? { [localName]: value } : void 0);
	return [
		reflect(desc, container),
		field,
		() => {
			const value = container[localName];
			if (value === void 0) {
				const desc = extension.message;
				if (isWrapperDesc(desc)) return scalarZeroValue(desc.fields[0].scalar, desc.fields[0].longAsString);
				return create(desc);
			}
			return value;
		}
	];
}
function assertExtendee(extension, message) {
	if (extension.extendee.typeName != message.$typeName) throw new Error(`extension ${extension.typeName} can only be applied to message ${extension.extendee.typeName}`);
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/wkt/json.js
/**
* Minimum google.protobuf.Timestamp in milliseconds (inclusive).
* Only enforced in ProtoJSON.
*
* @private
*/
var timestampMsMin = /*@__PURE__*/ Date.parse("0001-01-01T00:00:00Z");
/**
* Maximum google.protobuf.Timestamp in milliseconds (inclusive).
* Only enforced in ProtoJSON.
*
* @private
*/
var timestampMsMax = /*@__PURE__*/ Date.parse("9999-12-31T23:59:59Z");
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/to-json.js
var LEGACY_REQUIRED = 3;
var IMPLICIT$1 = 2;
var jsonWriteDefaults = {
	alwaysEmitImplicit: false,
	enumAsInteger: false,
	useProtoFieldName: false
};
function makeWriteOptions(options) {
	return options ? Object.assign(Object.assign({}, jsonWriteDefaults), options) : jsonWriteDefaults;
}
/**
* Serialize the message to a JSON value, a JavaScript value that can be
* passed to JSON.stringify().
*/
function toJson(schema, message, options) {
	return compiledWriter(schema)(makeWriteOptions(options), message);
}
/**
* Serialize the message to a JSON string.
*/
function toJsonString(schema, message, options) {
	var _a;
	const jsonValue = toJson(schema, message, options);
	return JSON.stringify(jsonValue, null, (_a = options === null || options === void 0 ? void 0 : options.prettySpaces) !== null && _a !== void 0 ? _a : 0);
}
var compiledWriters = /* @__PURE__ */ new WeakMap();
/**
* Return the compiled encoder for a message, compiling it on first use.
*/
function compiledWriter(desc) {
	let compiled = compiledWriters.get(desc);
	if (compiled === void 0) compiled = compileMessage$1(desc);
	return compiled;
}
function compileMessage$1(desc) {
	const typeName = desc.typeName;
	const writeWkt = compileWkt$1(desc);
	if (writeWkt !== void 0) {
		const foreignField = desc.fields[0];
		const compiledWriter = (opts, message) => {
			if (message.$typeName !== typeName && foreignField !== void 0) throw new FieldError(foreignField, `cannot use ${foreignField} with message ${message.$typeName}`, "ForeignFieldError");
			return writeWkt(opts, message);
		};
		compiledWriters.set(desc, compiledWriter);
		return compiledWriter;
	}
	const sortedFields = desc.fields.concat().sort((a, b) => a.number - b.number);
	const foreignField = sortedFields[0];
	const fieldWriters = [];
	const compiledWriter = (opts, message) => {
		if (message.$typeName !== typeName && foreignField !== void 0) throw new FieldError(foreignField, `cannot use ${foreignField} with message ${message.$typeName}`, "ForeignFieldError");
		const json = {};
		for (let i = 0; i < fieldWriters.length; i++) fieldWriters[i](opts, message, json);
		if (opts.registry) writeExtensions(json, opts, opts.registry, message, desc);
		return json;
	};
	compiledWriters.set(desc, compiledWriter);
	for (const field of sortedFields) fieldWriters.push(compileField(field));
	return compiledWriter;
}
/**
* Compile an encoder for a well-known type with a custom JSON representation,
* or return undefined for other messages.
*/
function compileWkt$1(desc) {
	if (!desc.typeName.startsWith("google.protobuf.")) return;
	switch (desc.typeName) {
		case "google.protobuf.Any": return (opts, message) => anyToJson(message, opts);
		case "google.protobuf.Timestamp": return (opts, message) => timestampToJson(message);
		case "google.protobuf.Duration": return (opts, message) => durationToJson(message);
		case "google.protobuf.FieldMask": return (opts, message) => fieldMaskToJson(message);
		case "google.protobuf.Struct": return (opts, message) => structToJson(message);
		case "google.protobuf.Value": return (opts, message) => valueToJson(message);
		case "google.protobuf.ListValue": return (opts, message) => listValueToJson(message);
		default:
			if (isWrapperDesc(desc)) {
				const valueField = desc.fields[0];
				const localName = valueField.localName;
				const zero = scalarZeroValue(valueField.scalar, false);
				const writeScalar = compileScalarValue(valueField);
				return (opts, message) => {
					const value = message[localName];
					return writeScalar(opts, value === void 0 ? zero : value);
				};
			}
			return;
	}
}
function compileField(field) {
	switch (field.fieldKind) {
		case "scalar":
		case "enum":
		case "message": return compileSingularField(field);
		case "list":
		case "map": {
			const writeValue = field.fieldKind == "list" ? compileListValue(field) : compileMapValue(field);
			const protoName = field.name;
			const jsonKey = field.jsonName;
			const localName = field.localName;
			return (opts, message, json) => {
				const value = writeValue(opts, message[localName]);
				if (value !== void 0) json[opts.useProtoFieldName ? protoName : jsonKey] = value;
			};
		}
	}
}
/**
* Compile an encoder for a singular field: the presence check, and the
* value encoder.
*/
function compileSingularField(field) {
	const writeValue = compileSingularValue(field);
	const protoName = field.name;
	const jsonKey = field.jsonName;
	const localName = field.localName;
	if (field.oneof) {
		const oneofLocalName = field.oneof.localName;
		return (opts, message, json) => {
			const oneof = message[oneofLocalName];
			if (oneof.case === localName) json[opts.useProtoFieldName ? protoName : jsonKey] = writeValue(opts, oneof.value);
		};
	}
	if (field.presence != IMPLICIT$1) {
		const requiredError = field.presence == LEGACY_REQUIRED ? `cannot encode ${field} to JSON: required field not set` : void 0;
		return (opts, message, json) => {
			const value = message[localName];
			if (value !== void 0 && Object.prototype.hasOwnProperty.call(message, localName)) json[opts.useProtoFieldName ? protoName : jsonKey] = writeValue(opts, value);
			else if (requiredError !== void 0) throw new Error(requiredError);
		};
	}
	if (field.fieldKind == "enum") {
		const zero = field.enum.values[0].number;
		return (opts, message, json) => {
			const value = message[localName];
			if (value !== zero || opts.alwaysEmitImplicit) json[opts.useProtoFieldName ? protoName : jsonKey] = writeValue(opts, value);
		};
	}
	switch (field.scalar) {
		case ScalarType.BOOL: return (opts, message, json) => {
			const value = message[localName];
			if (value !== false || opts.alwaysEmitImplicit) json[opts.useProtoFieldName ? protoName : jsonKey] = writeValue(opts, value);
		};
		case ScalarType.STRING: return (opts, message, json) => {
			const value = message[localName];
			if (value !== "" || opts.alwaysEmitImplicit) json[opts.useProtoFieldName ? protoName : jsonKey] = writeValue(opts, value);
		};
		case ScalarType.BYTES: return (opts, message, json) => {
			const value = message[localName];
			if (!(value instanceof Uint8Array) || value.byteLength > 0 || opts.alwaysEmitImplicit) json[opts.useProtoFieldName ? protoName : jsonKey] = writeValue(opts, value);
		};
		case ScalarType.DOUBLE:
		case ScalarType.FLOAT: return (opts, message, json) => {
			const value = message[localName];
			if (!Object.is(value, 0) || opts.alwaysEmitImplicit) json[opts.useProtoFieldName ? protoName : jsonKey] = writeValue(opts, value);
		};
		default: return (opts, message, json) => {
			const value = message[localName];
			if (value != 0 || opts.alwaysEmitImplicit) json[opts.useProtoFieldName ? protoName : jsonKey] = writeValue(opts, value);
		};
	}
}
/**
* Compile an encoder for the value of a field of any kind. Used for
* extension values.
*/
function compileFieldValue(field) {
	switch (field.fieldKind) {
		case "scalar":
		case "enum":
		case "message": return compileSingularValue(field);
		case "list": return compileListValue(field);
		case "map": return compileMapValue(field);
	}
}
/**
* Compile an encoder for the value of a singular field.
*/
function compileSingularValue(field) {
	switch (field.fieldKind) {
		case "scalar": return compileScalarValue(field);
		case "enum": return compileEnumValue(field);
		case "message": return compileMessageValue(field);
	}
}
/**
* Compile an encoder for the value of a message field.
*/
function compileMessageValue(field) {
	const { toMessage } = localMessageMapper(field);
	const writeMessage = compiledWriter(field.message);
	return (opts, value) => writeMessage(opts, toMessage(value));
}
/**
* Compile an encoder for a list field value. Returns undefined for an empty
* list, unless alwaysEmitImplicit is enabled.
*/
function compileListValue(field) {
	const writeItem = compileListItemValue(field);
	return (opts, value) => {
		const items = value;
		if (items.length == 0 && !opts.alwaysEmitImplicit) return;
		const jsonArray = [];
		for (let i = 0; i < items.length; i++) jsonArray.push(writeItem(opts, items[i]));
		return jsonArray;
	};
}
function compileListItemValue(field) {
	switch (field.listKind) {
		case "scalar": return compileScalarValue(field);
		case "enum": return compileEnumValue(field);
		case "message": return compileMessageValue(field);
	}
}
/**
* Compile an encoder for a map field value. Returns undefined for an empty
* map, unless alwaysEmitImplicit is enabled. Map keys are stored as object
* keys and are used as JSON keys as-is.
*/
function compileMapValue(field) {
	const writeMapValue = compileMapEntryValue(field);
	return (opts, value) => {
		const record = value;
		const keys = Object.keys(record);
		if (keys.length == 0 && !opts.alwaysEmitImplicit) return;
		const jsonObject = {};
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			jsonObject[key] = writeMapValue(opts, record[key]);
		}
		return jsonObject;
	};
}
function compileMapEntryValue(field) {
	switch (field.mapKind) {
		case "scalar": return compileScalarValue(field);
		case "enum": return compileEnumValue(field);
		case "message": return compileMessageValue(field);
	}
}
/**
* Compile an encoder for an enum value.
*/
function compileEnumValue(field) {
	const desc = field.enum;
	if (desc.typeName == "google.protobuf.NullValue") return (opts, value) => {
		if (typeof value != "number") throw errorEnumValue(desc, value);
		return null;
	};
	return (opts, value) => {
		var _a, _b;
		if (typeof value != "number") throw errorEnumValue(desc, value);
		if (opts.enumAsInteger) return value;
		return (_b = (_a = desc.value[value]) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : value;
	};
}
function errorEnumValue(desc, value) {
	return /* @__PURE__ */ new Error(`cannot encode ${desc} to JSON: expected number, got ${formatVal(value)}`);
}
/**
* Compile an encoder for a scalar value. Errors report the original field
* descriptor, which may be a list or map field for items of those fields.
*/
function compileScalarValue(field) {
	switch (field.scalar) {
		case ScalarType.INT32:
		case ScalarType.SFIXED32:
		case ScalarType.SINT32:
		case ScalarType.FIXED32:
		case ScalarType.UINT32: return (opts, value) => {
			if (typeof value != "number") throw errorScalarValue(field, value);
			return value;
		};
		case ScalarType.FLOAT:
		case ScalarType.DOUBLE: return (opts, value) => {
			if (typeof value != "number") throw errorScalarValue(field, value);
			if (Number.isNaN(value)) return "NaN";
			if (value === Number.POSITIVE_INFINITY) return "Infinity";
			if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
			return value;
		};
		case ScalarType.STRING: return (opts, value) => {
			if (typeof value != "string") throw errorScalarValue(field, value);
			return value;
		};
		case ScalarType.BOOL: return (opts, value) => {
			if (typeof value != "boolean") throw errorScalarValue(field, value);
			return value;
		};
		case ScalarType.UINT64:
		case ScalarType.FIXED64:
		case ScalarType.INT64:
		case ScalarType.SFIXED64:
		case ScalarType.SINT64: return (opts, value) => {
			if (typeof value == "bigint" || typeof value == "string" || typeof value == "number" && Number.isInteger(value)) return value.toString();
			throw errorScalarValue(field, value);
		};
		case ScalarType.BYTES: return (opts, value) => {
			if (value instanceof Uint8Array) return base64Encode(value);
			throw errorScalarValue(field, value);
		};
	}
}
function errorScalarValue(field, value) {
	var _a;
	return /* @__PURE__ */ new Error(`cannot encode ${field} to JSON: ${(_a = checkField(field, value)) === null || _a === void 0 ? void 0 : _a.message}`);
}
/**
* Write extensions for unknown fields that are found in the registry.
*/
function writeExtensions(json, opts, registry, message, desc) {
	const unknown = message.$unknown;
	if (unknown === void 0) return;
	const tagSeen = /* @__PURE__ */ new Set();
	for (let i = 0; i < unknown.length; i++) {
		const { no } = unknown[i];
		if (!tagSeen.has(no)) {
			tagSeen.add(no);
			const extension = registry.getExtensionFor(desc, no);
			if (!extension) continue;
			const [container, field] = createExtensionContainer(extension, getExtension(message, extension));
			const local = container[unsafeLocal];
			const jsonValue = compileFieldValue(field)(opts, local[field.localName]);
			if (jsonValue !== void 0) json[extension.jsonName] = jsonValue;
		}
	}
}
function anyToJson(val, opts) {
	if (val.typeUrl === "") return {};
	const { registry } = opts;
	let message;
	let desc;
	if (registry) {
		message = anyUnpack(val, registry);
		if (message) desc = registry.getMessage(message.$typeName);
	}
	if (!desc || !message) throw new Error(`cannot encode message ${val.$typeName} to JSON: "${val.typeUrl}" is not in the type registry`);
	const json = hasCustomJsonRepresentation(desc) ? { value: compiledWriter(desc)(opts, message) } : compiledWriter(desc)(opts, message);
	json["@type"] = val.typeUrl;
	return json;
}
function durationToJson(val) {
	const seconds = Number(val.seconds);
	const nanos = val.nanos;
	if (seconds > 315576e6 || seconds < -315576e6) throw new Error(`cannot encode message ${val.$typeName} to JSON: value out of range`);
	if (seconds > 0 && nanos < 0 || seconds < 0 && nanos > 0) throw new Error(`cannot encode message ${val.$typeName} to JSON: nanos sign must match seconds sign`);
	let text = val.seconds.toString();
	if (nanos !== 0) {
		let nanosStr = Math.abs(nanos).toString();
		nanosStr = "0".repeat(9 - nanosStr.length) + nanosStr;
		if (nanosStr.substring(3) === "000000") nanosStr = nanosStr.substring(0, 3);
		else if (nanosStr.substring(6) === "000") nanosStr = nanosStr.substring(0, 6);
		text += "." + nanosStr;
		if (nanos < 0 && seconds == 0) text = "-" + text;
	}
	return text + "s";
}
function fieldMaskToJson(val) {
	return val.paths.map((p) => {
		if (protoSnakeCase(protoCamelCase(p)) !== p) throw new Error(`cannot encode message ${val.$typeName} to JSON: lowerCamelCase of path name "${p}" is irreversible`);
		return protoCamelCase(p);
	}).join(",");
}
function structToJson(val) {
	const json = {};
	const keys = Object.keys(val.fields);
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		json[key] = valueToJson(val.fields[key]);
	}
	return json;
}
function valueToJson(val) {
	switch (val.kind.case) {
		case "nullValue": return null;
		case "numberValue":
			if (!Number.isFinite(val.kind.value)) throw new Error(`${val.$typeName} cannot be NaN or Infinity`);
			return val.kind.value;
		case "boolValue": return val.kind.value;
		case "stringValue": return val.kind.value;
		case "structValue": return structToJson(val.kind.value);
		case "listValue": return listValueToJson(val.kind.value);
		default: throw new Error(`${val.$typeName} must have a value`);
	}
}
function listValueToJson(val) {
	return val.values.map(valueToJson);
}
function timestampToJson(val) {
	const ms = Number(val.seconds) * 1e3;
	if (ms < timestampMsMin || ms > timestampMsMax) throw new Error(`cannot encode message ${val.$typeName} to JSON: must be from 0001-01-01T00:00:00Z to 9999-12-31T23:59:59Z inclusive`);
	if (val.nanos < 0) throw new Error(`cannot encode message ${val.$typeName} to JSON: nanos must not be negative`);
	if (val.nanos > 999999999) throw new Error(`cannot encode message ${val.$typeName} to JSON: nanos must not be greater than 99999999`);
	let z = "Z";
	if (val.nanos > 0) {
		const nanosStr = (val.nanos + 1e9).toString().substring(1);
		if (nanosStr.substring(3) === "000000") z = "." + nanosStr.substring(0, 3) + "Z";
		else if (nanosStr.substring(6) === "000") z = "." + nanosStr.substring(0, 6) + "Z";
		else z = "." + nanosStr + "Z";
	}
	return new Date(ms).toISOString().replace(".000Z", z);
}
//#endregion
//#region node_modules/@bufbuild/protobuf/dist/esm/from-json.js
var IMPLICIT = 2;
function makeReadContext(options) {
	return Object.assign(Object.assign({
		ignoreUnknownFields: false,
		recursionLimit: 100
	}, options), { depth: 0 });
}
/**
* Parse a message from a JSON string.
*
* Duplicate keys are rejected.
*/
function fromJsonString(schema, json, options) {
	return fromJson(schema, parseJsonString(json, schema.typeName), options);
}
/**
* Parse a message from a JSON value.
*
* Duplicate keys are rejected, but a value parsed by JSON.parse has already
* dropped duplicates (the last one wins). Use `fromJsonString` for strict
* duplicate-key checking.
*/
function fromJson(schema, json, options) {
	const message = create(schema);
	readMessage(schema, message, json, options);
	return message;
}
/**
* Run the compiled decoder for the message, wrapping FieldErrors with the
* standard error message.
*/
function readMessage(schema, message, json, options) {
	try {
		compiledReader(schema)(message, json, makeReadContext(options));
	} catch (e) {
		if (isFieldError(e)) throw new Error(`cannot decode ${e.field()} from JSON: ${e.message}`, { cause: e });
		throw e;
	}
}
var compiledReaders = /* @__PURE__ */ new WeakMap();
/**
* Return the compiled decoder for a message, compiling it on first use.
*/
function compiledReader(desc) {
	let compiled = compiledReaders.get(desc);
	if (compiled === void 0) compiled = compileMessage(desc);
	return compiled;
}
function compileMessage(desc) {
	const descString = String(desc);
	const readWkt = compileWkt(desc);
	if (readWkt !== void 0) {
		const compiled = (message, json, ctx) => {
			if (++ctx.depth > ctx.recursionLimit) throw new Error(`cannot decode ${descString} from JSON: maximum recursion depth of ${ctx.recursionLimit} reached`);
			readWkt(message, json, ctx);
			ctx.depth--;
		};
		compiledReaders.set(desc, compiled);
		return compiled;
	}
	const typeName = desc.typeName;
	const fieldsByJsonKey = /* @__PURE__ */ new Map();
	const compiled = (message, json, ctx) => {
		var _a;
		if (++ctx.depth > ctx.recursionLimit) throw new Error(`cannot decode ${descString} from JSON: maximum recursion depth of ${ctx.recursionLimit} reached`);
		if (json == null || Array.isArray(json) || typeof json != "object") throw new Error(`cannot decode ${descString} from JSON: ${formatVal(json)}`);
		const oneofSeen = /* @__PURE__ */ new Map();
		const fieldSeen = /* @__PURE__ */ new Set();
		const jsonKeys = Object.keys(json);
		for (let i = 0; i < jsonKeys.length; i++) {
			const jsonKey = jsonKeys[i];
			const jsonValue = json[jsonKey];
			const entry = fieldsByJsonKey.get(jsonKey);
			if (entry !== void 0) {
				const field = entry.field;
				if (fieldSeen.has(field)) throw new FieldError(field, "set multiple times");
				fieldSeen.add(field);
				if (entry.oneofScalarNullSkip && jsonValue === null) continue;
				if (entry.oneof) {
					const seen = oneofSeen.get(entry.oneof);
					if (seen !== void 0) throw new FieldError(entry.oneof, `oneof set multiple times by ${seen.name} and ${field.name}`);
					oneofSeen.set(entry.oneof, field);
				}
				entry.read(message, jsonValue, ctx);
			} else {
				const extension = jsonKey.startsWith("[") && jsonKey.endsWith("]") ? (_a = ctx.registry) === null || _a === void 0 ? void 0 : _a.getExtension(jsonKey.substring(1, jsonKey.length - 1)) : void 0;
				if ((extension === null || extension === void 0 ? void 0 : extension.extendee.typeName) == typeName) {
					const [container, field, get] = createExtensionContainer(extension);
					compileFieldReader(field)(container[unsafeLocal], jsonValue, ctx);
					setExtension(message, extension, get());
				}
				if (extension === void 0 && !ctx.ignoreUnknownFields) throw new Error(`cannot decode ${descString} from JSON: key "${jsonKey}" is unknown`);
			}
		}
		ctx.depth--;
	};
	compiledReaders.set(desc, compiled);
	for (const field of desc.fields) {
		const entry = {
			read: compileFieldReader(field),
			field,
			oneof: field.oneof,
			oneofScalarNullSkip: field.oneof !== void 0 && field.fieldKind == "scalar"
		};
		fieldsByJsonKey.set(field.name, entry).set(field.jsonName, entry);
	}
	return compiled;
}
/**
* Compile a decoder for a well-known type with a custom JSON representation,
* or return undefined for other messages. The recursion limit is enforced by
* the caller.
*/
function compileWkt(desc) {
	if (!desc.typeName.startsWith("google.protobuf.")) return;
	switch (desc.typeName) {
		case "google.protobuf.Any": return (message, json, ctx) => anyFromJson(message, json, ctx);
		case "google.protobuf.Timestamp": return (message, json) => timestampFromJson(message, json);
		case "google.protobuf.Duration": return (message, json) => durationFromJson(message, json);
		case "google.protobuf.FieldMask": return (message, json) => fieldMaskFromJson(message, json);
		case "google.protobuf.Struct": return (message, json, ctx) => structFromJson(message, json, ctx);
		case "google.protobuf.Value": return (message, json, ctx) => valueFromJson(message, json, ctx);
		case "google.protobuf.ListValue": return (message, json, ctx) => listValueFromJson(message, json, ctx);
		default:
			if (isWrapperDesc(desc)) {
				const valueField = desc.fields[0];
				const localName = valueField.localName;
				const scalar = valueField.scalar;
				const longAsString = valueField.longAsString;
				const readScalar = compileScalarConverter(valueField);
				return (message, json) => {
					if (json === null) message[localName] = scalarZeroValue(scalar, longAsString);
					else message[localName] = readScalar(json);
				};
			}
			return;
	}
}
function compileFieldReader(field) {
	switch (field.fieldKind) {
		case "scalar": return compileScalarFieldReader(field);
		case "enum": return compileEnumFieldReader(field);
		case "message": return compileMessageFieldReader(field);
		case "list": return compileListFieldReader(field);
		case "map": return compileMapFieldReader(field);
	}
}
function compileScalarFieldReader(field) {
	const readScalar = compileScalarConverter(field);
	const localName = field.localName;
	if (field.oneof) {
		const oneofLocalName = field.oneof.localName;
		return (message, json) => {
			message[oneofLocalName] = {
				case: localName,
				value: readScalar(json)
			};
		};
	}
	const clear = compileClear(field);
	return (message, json) => {
		if (json === null) clear(message);
		else message[localName] = readScalar(json);
	};
}
/**
* Compile a function that resets the field to unset, mirroring the clear
* operation of the reflect API for fields that are not part of a oneof.
*/
function compileClear(field) {
	const localName = field.localName;
	if (field.presence != IMPLICIT) return (message) => {
		delete message[localName];
	};
	if (field.fieldKind == "enum") {
		const zero = field.enum.values[0].number;
		return (message) => {
			message[localName] = zero;
		};
	}
	const scalar = field.scalar;
	const longAsString = field.longAsString;
	return (message) => {
		message[localName] = scalarZeroValue(scalar, longAsString);
	};
}
function compileEnumFieldReader(field) {
	const readEnumValue = compileEnumConverter(field.enum);
	const checkEnum = compileEnumCheck(field.enum);
	const localName = field.localName;
	const nullResets = field.enum.typeName != "google.protobuf.NullValue";
	if (field.oneof) {
		const oneofLocalName = field.oneof.localName;
		return (message, json, ctx) => {
			if (json === null && nullResets) {
				if (message[oneofLocalName].case === localName) message[oneofLocalName] = { case: void 0 };
				return;
			}
			const value = readEnumValue(json, ctx.ignoreUnknownFields);
			if (value === tokenIgnoredUnknownEnum) return;
			const check = checkEnum(value);
			if (check !== true) throw new FieldError(field, reasonSingular(field, value, check));
			message[oneofLocalName] = {
				case: localName,
				value
			};
		};
	}
	const clear = compileClear(field);
	return (message, json, ctx) => {
		if (json === null && nullResets) {
			clear(message);
			return;
		}
		const value = readEnumValue(json, ctx.ignoreUnknownFields);
		if (value === tokenIgnoredUnknownEnum) return;
		const check = checkEnum(value);
		if (check !== true) throw new FieldError(field, reasonSingular(field, value, check));
		message[localName] = value;
	};
}
function compileMessageFieldReader(field) {
	const localName = field.localName;
	const { toMessage, toLocal } = localMessageMapper(field);
	const readChild = compiledReader(field.message);
	const nullResets = field.message.typeName != "google.protobuf.Value";
	if (field.oneof) {
		const oneofLocalName = field.oneof.localName;
		return (message, json, ctx) => {
			const oneof = message[oneofLocalName];
			if (json === null && nullResets) {
				if (oneof.case === localName) message[oneofLocalName] = { case: void 0 };
				return;
			}
			const child = toMessage(oneof.case === localName ? oneof.value : void 0);
			readChild(child, json, ctx);
			message[oneofLocalName] = {
				case: localName,
				value: toLocal(child)
			};
		};
	}
	return (message, json, ctx) => {
		if (json === null && nullResets) {
			delete message[localName];
			return;
		}
		const child = toMessage(message[localName]);
		readChild(child, json, ctx);
		message[localName] = toLocal(child);
	};
}
function compileListFieldReader(field) {
	const localName = field.localName;
	const readItem = compileListItemReader(field);
	return (message, json, ctx) => {
		if (json === null) return;
		if (!Array.isArray(json)) throw new FieldError(field, "expected Array, got " + formatVal(json));
		const items = message[localName];
		for (let i = 0; i < json.length; i++) {
			const value = readItem(json[i], ctx, items.length);
			if (value !== tokenIgnoredUnknownEnum) items.push(value);
		}
	};
}
/**
* Compile a decoder for a list item. The index is only used in errors, and
* accounts for previously merged items.
*/
function compileListItemReader(field) {
	switch (field.listKind) {
		case "scalar": {
			const parseScalar = compileScalarParse(field);
			const checkValue = checkScalarValue(field.scalar);
			const toLocal = compileScalarToLocal(field);
			return (json, ctx, index) => {
				if (json === null) throw new FieldError(field, "list item must not be null");
				const value = parseScalar(json);
				const check = checkValue(value);
				if (check !== true) throw new FieldError(field, `list item #${index + 1}: ${reasonSingular(field, value, check)}`);
				return toLocal(value);
			};
		}
		case "enum": {
			const readEnumValue = compileEnumConverter(field.enum);
			const checkEnum = compileEnumCheck(field.enum);
			const nullResets = field.enum.typeName != "google.protobuf.NullValue";
			return (json, ctx, index) => {
				if (json === null && nullResets) throw new FieldError(field, "list item must not be null");
				const value = readEnumValue(json, ctx.ignoreUnknownFields);
				if (value === tokenIgnoredUnknownEnum) return value;
				const check = checkEnum(value);
				if (check !== true) throw new FieldError(field, `list item #${index + 1}: ${reasonSingular(field, value, check)}`);
				return value;
			};
		}
		case "message": {
			const { toMessage, toLocal } = localMessageMapper(field);
			const readChild = compiledReader(field.message);
			const nullResets = field.message.typeName != "google.protobuf.Value";
			return (json, ctx) => {
				if (json === null && nullResets) throw new FieldError(field, "list item must not be null");
				const child = toMessage(void 0);
				readChild(child, json, ctx);
				return toLocal(child);
			};
		}
	}
}
function compileMapFieldReader(field) {
	const localName = field.localName;
	const mapKey = field.mapKey;
	const parseMapKey = compileMapKeyParse(mapKey);
	const checkMapKey = checkScalarValue(mapKey);
	let parseValue;
	let checkValue;
	let toLocalValue = (value) => value;
	let nullResets = true;
	switch (field.mapKind) {
		case "scalar":
			parseValue = compileScalarParse(field);
			checkValue = checkScalarValue(field.scalar);
			toLocalValue = compileScalarToLocal(field);
			break;
		case "enum": {
			const readEnumValue = compileEnumConverter(field.enum);
			parseValue = (json, ctx) => readEnumValue(json, ctx.ignoreUnknownFields);
			checkValue = compileEnumCheck(field.enum);
			nullResets = field.enum.typeName != "google.protobuf.NullValue";
			break;
		}
		case "message": {
			const { toMessage, toLocal } = localMessageMapper(field);
			const readChild = compiledReader(field.message);
			nullResets = field.message.typeName != "google.protobuf.Value";
			parseValue = (json, ctx) => {
				const child = toMessage(void 0);
				readChild(child, json, ctx);
				return toLocal(child);
			};
			break;
		}
	}
	return (message, json, ctx) => {
		if (json === null) return;
		if (typeof json != "object" || Array.isArray(json)) throw new FieldError(field, "expected object, got " + formatVal(json));
		const record = message[localName];
		const seen = /* @__PURE__ */ new Set();
		const jsonMapKeys = Object.keys(json);
		for (let i = 0; i < jsonMapKeys.length; i++) {
			const jsonMapKey = jsonMapKeys[i];
			const jsonMapValue = json[jsonMapKey];
			const key = parseMapKey(jsonMapKey);
			if (seen.has(key)) throw new FieldError(field, `duplicate map key "${jsonMapKey}"`);
			seen.add(key);
			if (jsonMapValue === null && nullResets) throw new FieldError(field, "map value must not be null");
			const value = parseValue(jsonMapValue, ctx);
			if (value === tokenIgnoredUnknownEnum) continue;
			const checkKey = checkMapKey(key);
			if (checkKey !== true) throw new FieldError(field, `invalid map key: ${reasonSingular({ scalar: mapKey }, key, checkKey)}`);
			if (checkValue !== void 0) {
				const check = checkValue(value);
				if (check !== true) throw new FieldError(field, `map entry ${formatVal(key)}: ${reasonSingular(field, value, check)}`);
			}
			record[key] = toLocalValue(value);
		}
	};
}
var tokenIgnoredUnknownEnum = Symbol();
/**
* Compile a converter from a JSON value to an enum value. JSON null returns
* the enum's first value. With ignoreUnknownFields false, unknown string
* values raise an error; with true, they return tokenIgnoredUnknownEnum.
* The value is not checked against the enum's values, see compileEnumCheck.
*/
function compileEnumConverter(desc) {
	const zero = desc.values[0].number;
	const values = desc.values;
	return (json, ignoreUnknownFields) => {
		if (json === null) return zero;
		switch (typeof json) {
			case "number":
				if (Number.isInteger(json)) return json;
				break;
			case "string": {
				const value = values.find((ev) => ev.name === json);
				if (value !== void 0) return value.number;
				if (ignoreUnknownFields) return tokenIgnoredUnknownEnum;
				break;
			}
		}
		throw new Error(`cannot decode ${desc} from JSON: ${formatVal(json)}`);
	};
}
/**
* Compile the check that the reflect API performs for enum values: open
* enums accept any int32 value, closed enums accept only declared values.
*/
function compileEnumCheck(desc) {
	if (desc.open) return checkScalarValue(ScalarType.INT32);
	const values = desc.values;
	return (value) => values.some((v) => v.number === value);
}
/**
* Compile a converter from a JSON value to the local representation of a
* scalar, fusing JSON parsing, the validation of the reflect API, and the
* conversion to the local 64-bit integer representation.
*/
function compileScalarConverter(field) {
	const parseScalar = compileScalarParse(field);
	const checkValue = checkScalarValue(field.scalar);
	const toLocal = compileScalarToLocal(field);
	return (json) => {
		const value = parseScalar(json);
		const check = checkValue(value);
		if (check !== true) throw new FieldError(field, reasonSingular(field, value, check));
		return toLocal(value);
	};
}
/**
* Compile the JSON-specific parsing step for a scalar value: the special
* string values of float and double, string-encoded numbers, and base64
* bytes. Returns the input unchanged if the JSON value cannot be converted;
* the validation step raises an error for it.
*/
function compileScalarParse(field) {
	switch (field.scalar) {
		case ScalarType.DOUBLE:
		case ScalarType.FLOAT: return (json) => {
			if (json === "NaN") return NaN;
			if (json === "Infinity") return Number.POSITIVE_INFINITY;
			if (json === "-Infinity") return Number.NEGATIVE_INFINITY;
			if (typeof json == "number") {
				if (Number.isNaN(json)) throw new FieldError(field, "unexpected NaN number");
				if (!Number.isFinite(json)) throw new FieldError(field, "unexpected infinite number");
				return json;
			}
			if (typeof json == "string") {
				if (json === "") return json;
				if (json.trim().length !== json.length) return json;
				const float = Number(json);
				if (!Number.isFinite(float)) return json;
				return float;
			}
			return json;
		};
		case ScalarType.INT32:
		case ScalarType.FIXED32:
		case ScalarType.SFIXED32:
		case ScalarType.SINT32:
		case ScalarType.UINT32: return int32FromJson;
		case ScalarType.BYTES: return (json) => {
			if (typeof json == "string") {
				if (json === "") return /* @__PURE__ */ new Uint8Array(0);
				try {
					return base64Decode(json);
				} catch (e) {
					throw new FieldError(field, e instanceof Error ? e.message : String(e));
				}
			}
			return json;
		};
		default: return (json) => json;
	}
}
/**
* Compile the conversion of a validated scalar value to its local
* representation: 64-bit integers become bigint, or string with the
* longAsString option.
*/
function compileScalarToLocal(field) {
	const longAsString = field.fieldKind !== "map" && field.longAsString;
	switch (field.scalar) {
		case ScalarType.INT64:
		case ScalarType.SFIXED64:
		case ScalarType.SINT64:
			if (longAsString) return (value) => String(value);
			return (value) => typeof value == "string" || typeof value == "number" ? protoInt64.parse(value) : value;
		case ScalarType.FIXED64:
		case ScalarType.UINT64:
			if (longAsString) return (value) => String(value);
			return (value) => typeof value == "string" || typeof value == "number" ? protoInt64.uParse(value) : value;
		default: return (value) => value;
	}
}
/**
* Return a parser from a JSON value to a map key for the given key type.
* Canonicalizes 64-bit integers given as string, so that "01" and "1" are
* one key, and duplicates can raise an error.
* The parser returns the input if the JSON value cannot be converted.
*/
function compileMapKeyParse(type) {
	switch (type) {
		case ScalarType.BOOL: return (jsonString) => {
			switch (jsonString) {
				case "true": return true;
				case "false": return false;
			}
			return jsonString;
		};
		case ScalarType.INT32:
		case ScalarType.FIXED32:
		case ScalarType.UINT32:
		case ScalarType.SFIXED32:
		case ScalarType.SINT32: return int32FromJson;
		case ScalarType.INT64:
		case ScalarType.SINT64:
		case ScalarType.SFIXED64:
		case ScalarType.UINT64:
		case ScalarType.FIXED64: return (jsonString) => /^-?0+$/.test(jsonString) ? "0" : jsonString.replace(/^(-?)0+(?=\d)/, "$1");
		default: return (jsonString) => jsonString;
	}
}
/**
* Try to parse a JSON value to a 32-bit integer for the reflect API.
*
* Returns the input if the JSON value cannot be converted.
*/
function int32FromJson(json) {
	if (typeof json == "string") {
		if (json === "") return json;
		if (json.trim().length !== json.length) return json;
		const num = Number(json);
		if (Number.isNaN(num)) return json;
		return num;
	}
	return json;
}
/**
* Parse a JSON string, rejecting duplicate object keys (which JSON.parse would
* otherwise silently merge).
*/
function parseJsonString(jsonString, typeName) {
	let json;
	try {
		json = JSON.parse(jsonString);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw new Error(`cannot decode message ${typeName} from JSON: ${message}`, { cause: e });
	}
	checkDuplicateKeys(jsonString, typeName);
	return json;
}
/**
* Scan a JSON string for duplicate object member names at any depth, throwing
* if any are found. JSON.parse() silently keeps the last of duplicate keys, so
* this raw-string scan is the only way to reject them. It must only be called
* with a string that JSON.parse() has already accepted, so it can assume the
* input is well-formed.
*/
function checkDuplicateKeys(jsonString, typeName) {
	const stack = [];
	let expectKey = false;
	let i = 0;
	while (i < jsonString.length) switch (jsonString[i]) {
		case "{":
			stack.push(/* @__PURE__ */ new Set());
			expectKey = true;
			i++;
			break;
		case "[":
			stack.push(null);
			expectKey = false;
			i++;
			break;
		case "}":
		case "]":
			stack.pop();
			expectKey = false;
			i++;
			break;
		case ",":
			expectKey = stack[stack.length - 1] != null;
			i++;
			break;
		case ":":
			expectKey = false;
			i++;
			break;
		case "\"": {
			const open = i++;
			let escaped = false;
			while (i < jsonString.length) {
				if (jsonString[i] == "\\") {
					escaped = true;
					i += 2;
					continue;
				}
				if (jsonString[i] == "\"") break;
				i++;
			}
			const close = i++;
			const seen = stack[stack.length - 1];
			if (expectKey && seen) {
				const name = escaped ? JSON.parse(jsonString.substring(open, close + 1)) : jsonString.substring(open + 1, close);
				if (seen.has(name)) throw new Error(`cannot decode message ${typeName} from JSON: duplicate object key "${name}"`);
				seen.add(name);
			}
			expectKey = false;
			break;
		}
		default: i++;
	}
}
function anyFromJson(any, json, ctx) {
	var _a;
	if (json === null || Array.isArray(json) || typeof json != "object") throw new Error(`cannot decode message ${any.$typeName} from JSON: expected object but got ${formatVal(json)}`);
	if (Object.keys(json).length == 0) return;
	const typeUrl = json["@type"];
	if (typeof typeUrl != "string" || typeUrl == "") throw new Error(`cannot decode message ${any.$typeName} from JSON: "@type" is empty`);
	const typeName = typeUrl.includes("/") ? typeUrl.substring(typeUrl.lastIndexOf("/") + 1) : typeUrl;
	if (!typeName.length) throw new Error(`cannot decode message ${any.$typeName} from JSON: "@type" is invalid`);
	const desc = (_a = ctx.registry) === null || _a === void 0 ? void 0 : _a.getMessage(typeName);
	if (!desc) throw new Error(`cannot decode message ${any.$typeName} from JSON: ${typeUrl} is not in the type registry`);
	const message = create(desc);
	if (hasCustomJsonRepresentation(desc) && Object.prototype.hasOwnProperty.call(json, "value")) compiledReader(desc)(message, json.value, ctx);
	else {
		const copy = Object.assign({}, json);
		delete copy["@type"];
		compiledReader(desc)(message, copy, ctx);
	}
	anyPack(desc, message, any);
}
function timestampFromJson(timestamp, json) {
	if (typeof json !== "string") throw new Error(`cannot decode message ${timestamp.$typeName} from JSON: ${formatVal(json)}`);
	const matches = json.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(?:Z|([+-][0-9][0-9]:[0-9][0-9]))$/);
	if (!matches) throw new Error(`cannot decode message ${timestamp.$typeName} from JSON: invalid RFC 3339 string`);
	const ms = Date.parse(matches[1] + "-" + matches[2] + "-" + matches[3] + "T" + matches[4] + ":" + matches[5] + ":" + matches[6] + (matches[8] ? matches[8] : "Z"));
	if (Number.isNaN(ms)) throw new Error(`cannot decode message ${timestamp.$typeName} from JSON: invalid RFC 3339 string`);
	if (ms < timestampMsMin || ms > timestampMsMax) throw new Error(`cannot decode message ${timestamp.$typeName} from JSON: must be from 0001-01-01T00:00:00Z to 9999-12-31T23:59:59Z inclusive`);
	timestamp.seconds = protoInt64.parse(ms / 1e3);
	timestamp.nanos = 0;
	if (matches[7]) timestamp.nanos = parseInt("1" + matches[7] + "0".repeat(9 - matches[7].length)) - 1e9;
}
function durationFromJson(duration, json) {
	if (typeof json !== "string") throw new Error(`cannot decode message ${duration.$typeName} from JSON: ${formatVal(json)}`);
	const match = json.match(/^(-?[0-9]+)(?:\.([0-9]+))?s/);
	if (match === null) throw new Error(`cannot decode message ${duration.$typeName} from JSON: ${formatVal(json)}`);
	const longSeconds = Number(match[1]);
	if (longSeconds > 315576e6 || longSeconds < -315576e6) throw new Error(`cannot decode message ${duration.$typeName} from JSON: ${formatVal(json)}`);
	duration.seconds = protoInt64.parse(longSeconds);
	if (typeof match[2] !== "string") return;
	const nanosStr = match[2] + "0".repeat(9 - match[2].length);
	duration.nanos = parseInt(nanosStr);
	if (longSeconds < 0 || Object.is(longSeconds, -0)) duration.nanos = -duration.nanos;
}
function fieldMaskFromJson(fieldMask, json) {
	if (typeof json !== "string") throw new Error(`cannot decode message ${fieldMask.$typeName} from JSON: ${formatVal(json)}`);
	if (json === "") return;
	fieldMask.paths = json.split(",").map((path) => {
		if (path.includes("_")) throw new Error(`cannot decode message ${fieldMask.$typeName} from JSON: path names must be lowerCamelCase`);
		return protoSnakeCase(path);
	});
}
function structFromJson(struct, json, ctx) {
	if (typeof json != "object" || json == null || Array.isArray(json)) throw new Error(`cannot decode message ${struct.$typeName} from JSON ${formatVal(json)}`);
	const keys = Object.keys(json);
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		const parsedValue = create(ValueSchema);
		valueFromJson(parsedValue, json[key], ctx);
		struct.fields[key] = parsedValue;
	}
}
function valueFromJson(value, json, ctx) {
	if (++ctx.depth > ctx.recursionLimit) throw new Error(`cannot decode ${value.$typeName} from JSON: maximum recursion depth of ${ctx.recursionLimit} reached`);
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
				value: NullValue.NULL_VALUE
			};
			else if (Array.isArray(json)) {
				const listValue = create(ListValueSchema);
				listValueFromJson(listValue, json, ctx);
				value.kind = {
					case: "listValue",
					value: listValue
				};
			} else {
				const struct = create(StructSchema);
				structFromJson(struct, json, ctx);
				value.kind = {
					case: "structValue",
					value: struct
				};
			}
			break;
		default: throw new Error(`cannot decode message ${value.$typeName} from JSON ${formatVal(json)}`);
	}
	ctx.depth--;
	return value;
}
function listValueFromJson(listValue, json, ctx) {
	if (!Array.isArray(json)) throw new Error(`cannot decode message ${listValue.$typeName} from JSON ${formatVal(json)}`);
	for (let i = 0; i < json.length; i++) {
		const value = create(ValueSchema);
		valueFromJson(value, json[i], ctx);
		listValue.values.push(value);
	}
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/code.js
/**
* Connect represents categories of errors as codes, and each code maps to a
* specific HTTP status code. The codes and their semantics were chosen to
* match gRPC. Only the codes below are valid — there are no user-defined
* codes.
*
* See the specification at https://connectrpc.com/docs/protocol#error-codes
* for details.
*/
var Code;
(function(Code) {
	/**
	* Canceled, usually by the user
	*/
	Code[Code["Canceled"] = 1] = "Canceled";
	/**
	* Unknown error
	*/
	Code[Code["Unknown"] = 2] = "Unknown";
	/**
	* Argument invalid regardless of system state
	*/
	Code[Code["InvalidArgument"] = 3] = "InvalidArgument";
	/**
	* Operation expired, may or may not have completed.
	*/
	Code[Code["DeadlineExceeded"] = 4] = "DeadlineExceeded";
	/**
	* Entity not found.
	*/
	Code[Code["NotFound"] = 5] = "NotFound";
	/**
	* Entity already exists.
	*/
	Code[Code["AlreadyExists"] = 6] = "AlreadyExists";
	/**
	* Operation not authorized.
	*/
	Code[Code["PermissionDenied"] = 7] = "PermissionDenied";
	/**
	* Quota exhausted.
	*/
	Code[Code["ResourceExhausted"] = 8] = "ResourceExhausted";
	/**
	* Argument invalid in current system state.
	*/
	Code[Code["FailedPrecondition"] = 9] = "FailedPrecondition";
	/**
	* Operation aborted.
	*/
	Code[Code["Aborted"] = 10] = "Aborted";
	/**
	* Out of bounds, use instead of FailedPrecondition.
	*/
	Code[Code["OutOfRange"] = 11] = "OutOfRange";
	/**
	* Operation not implemented or disabled.
	*/
	Code[Code["Unimplemented"] = 12] = "Unimplemented";
	/**
	* Internal error, reserved for "serious errors".
	*/
	Code[Code["Internal"] = 13] = "Internal";
	/**
	* Unavailable, client should back off and retry.
	*/
	Code[Code["Unavailable"] = 14] = "Unavailable";
	/**
	* Unrecoverable data loss or corruption.
	*/
	Code[Code["DataLoss"] = 15] = "DataLoss";
	/**
	* Request isn't authenticated.
	*/
	Code[Code["Unauthenticated"] = 16] = "Unauthenticated";
})(Code || (Code = {}));
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-connect/code-string.js
/**
* codeToString returns the string representation of a Code.
*
* @private Internal code, does not follow semantic versioning.
*/
function codeToString(value) {
	const name = Code[value];
	if (typeof name != "string") return value.toString();
	return name[0].toLowerCase() + name.substring(1).replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}
var stringToCode;
/**
* codeFromString parses the string representation of a Code in snake_case.
* For example, the string "permission_denied" parses into Code.PermissionDenied.
*
* If the given string cannot be parsed, the function returns undefined.
*
* @private Internal code, does not follow semantic versioning.
*/
function codeFromString(value) {
	if (!stringToCode) {
		stringToCode = {};
		for (const value of Object.values(Code)) {
			if (typeof value == "string") continue;
			stringToCode[codeToString(value)] = value;
		}
	}
	return stringToCode[value];
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/connect-error.js
/**
* ConnectError captures four pieces of information: a Code, an error
* message, an optional cause of the error, and an optional collection of
* arbitrary Protobuf messages called  "details".
*
* Because developer tools typically show just the error message, we prefix
* it with the status code, so that the most important information is always
* visible immediately.
*
* Error details are wrapped with google.protobuf.Any on the wire, so that
* a server or middleware can attach arbitrary data to an error. Use the
* method findDetails() to retrieve the details.
*/
var ConnectError = class ConnectError extends Error {
	/**
	* Create a new ConnectError.
	* If no code is provided, code "unknown" is used.
	* Outgoing details are only relevant for the server side - a service may
	* raise an error with details, and it is up to the protocol implementation
	* to encode and send the details along with the error.
	*/
	constructor(message, code = Code.Unknown, metadata, outgoingDetails, cause) {
		super(createMessage(message, code));
		this.name = "ConnectError";
		/**
		* @private Internal field, indicates whether this error was parsed from the
		* wire by a Connect client, as opposed to being created by application code.
		*
		* Do not set this field in application code.
		*/
		this.isWireError = false;
		Object.setPrototypeOf(this, new.target.prototype);
		this.rawMessage = message;
		this.code = code;
		this.metadata = new Headers(metadata !== null && metadata !== void 0 ? metadata : {});
		this.details = outgoingDetails !== null && outgoingDetails !== void 0 ? outgoingDetails : [];
		this.cause = cause;
	}
	/**
	* Convert any value - typically a caught error into a ConnectError,
	* following these rules:
	* - If the value is already a ConnectError, return it as is.
	* - If the value is an AbortError or TimeoutError from the fetch API, return
	*   the message of the error with code Canceled.
	* - For other Errors, return the error message with code Unknown by default.
	* - For other values, return the values String representation as a message,
	*   with the code Unknown by default.
	* The original value will be used for the "cause" property for the new
	* ConnectError.
	*/
	static from(reason, code = Code.Unknown) {
		if (reason instanceof ConnectError) return reason;
		if (reason instanceof Error) {
			if (reason.name == "AbortError" || reason.name == "TimeoutError") return new ConnectError(reason.message, Code.Canceled);
			return new ConnectError(reason.message, code, void 0, void 0, reason);
		}
		return new ConnectError(String(reason), code, void 0, void 0, reason);
	}
	static [Symbol.hasInstance](v) {
		if (!(v instanceof Error)) return false;
		if (Object.getPrototypeOf(v) === ConnectError.prototype) return true;
		return v.name === "ConnectError" && "code" in v && typeof v.code === "number" && "metadata" in v && "details" in v && Array.isArray(v.details) && "rawMessage" in v && typeof v.rawMessage == "string" && "cause" in v;
	}
	findDetails(typeOrRegistry) {
		const registry = typeOrRegistry.kind === "message" ? { getMessage: (typeName) => typeName === typeOrRegistry.typeName ? typeOrRegistry : void 0 } : typeOrRegistry;
		const details = [];
		for (const data of this.details) {
			if ("desc" in data) {
				if (registry.getMessage(data.desc.typeName)) details.push(create(data.desc, data.value));
				continue;
			}
			const desc = registry.getMessage(data.type);
			if (desc) try {
				details.push(fromBinary(desc, data.value));
			} catch (_) {}
		}
		return details;
	}
};
/**
* Create an error message, prefixing the given code.
*/
function createMessage(message, code) {
	return message.length ? `[${codeToString(code)}] ${message}` : `[${codeToString(code)}]`;
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/http-headers.js
function encodeBinaryHeader(value, desc) {
	let bytes;
	if (desc !== void 0) bytes = toBinary(desc, value);
	else if (typeof value == "string") bytes = new TextEncoder().encode(value);
	else bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
	return base64Encode(bytes, "std_raw");
}
function decodeBinaryHeader(value, desc, options) {
	try {
		const bytes = base64Decode(value);
		if (desc) return fromBinary(desc, bytes, options);
		return bytes;
	} catch (e) {
		throw ConnectError.from(e, Code.DataLoss);
	}
}
/**
* Merge two or more Headers objects by appending all fields from
* all inputs to a new Headers object.
*/
function appendHeaders(...headers) {
	const h = new Headers();
	for (const e of headers) e.forEach((value, key) => {
		h.append(key, value);
	});
	return h;
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/any-client.js
/**
* Create any client for the given service.
*
* The given createMethod function is called for each method definition
* of the service. The function it returns is added to the client object
* as a method.
*/
function makeAnyClient(service, createMethod) {
	const client = {};
	for (const desc of service.methods) {
		const method = createMethod(desc);
		if (method != null) client[desc.localName] = method;
	}
	return client;
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol/compression.js
/**
* Validates the request encoding and determines the accepted response encoding.
*
* Returns the request and response compression to use. If the client requested
* an encoding that is not available, the returned object contains an error that
* must be used for the response.
*
* @private Internal code, does not follow semantic versioning.
*/
function compressionNegotiate(available, requested, accepted, headerNameAcceptEncoding) {
	let request = null;
	let response = null;
	let error = void 0;
	if (requested !== null && requested !== "identity") {
		const found = available.find((c) => c.name === requested);
		if (found) request = found;
		else {
			const acceptable = available.map((c) => c.name).join(",");
			error = new ConnectError(`unknown compression "${requested}": supported encodings are ${acceptable}`, Code.Unimplemented, { [headerNameAcceptEncoding]: acceptable });
		}
	}
	if (accepted === null || accepted === "") response = request;
	else {
		const acceptNames = accepted.split(",").map((n) => n.trim());
		for (const name of acceptNames) {
			const found = available.find((c) => c.name === name);
			if (found) {
				response = found;
				break;
			}
		}
	}
	return {
		request,
		response,
		error
	};
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol/limit-io.js
/**
* At most, allow ~4GiB to be received or sent per message.
* zlib used by Node.js caps maxOutputLength at this value. It also happens to
* be the maximum theoretical message size supported by protobuf-es.
*/
var maxReadMaxBytes = 4294967295;
var maxWriteMaxBytes = maxReadMaxBytes;
/**
* The default value for the compressMinBytes option. The CPU cost of compressing
* very small messages usually isn't worth the small reduction in network I/O, so
* the default value is 1 kibibyte.
*/
var defaultCompressMinBytes = 1024;
/**
* Asserts that the options writeMaxBytes, readMaxBytes, and compressMinBytes
* are within sane limits, and returns default values where no value is
* provided.
*
* @private Internal code, does not follow semantic versioning.
*/
function validateReadWriteMaxBytes(readMaxBytes, writeMaxBytes, compressMinBytes) {
	writeMaxBytes !== null && writeMaxBytes !== void 0 || (writeMaxBytes = maxWriteMaxBytes);
	readMaxBytes !== null && readMaxBytes !== void 0 || (readMaxBytes = maxReadMaxBytes);
	compressMinBytes !== null && compressMinBytes !== void 0 || (compressMinBytes = defaultCompressMinBytes);
	if (writeMaxBytes < 1 || writeMaxBytes > maxWriteMaxBytes) throw new ConnectError(`writeMaxBytes ${writeMaxBytes} must be >= 1 and <= ${maxWriteMaxBytes}`, Code.Internal);
	if (readMaxBytes < 1 || readMaxBytes > maxReadMaxBytes) throw new ConnectError(`readMaxBytes ${readMaxBytes} must be >= 1 and <= ${maxReadMaxBytes}`, Code.Internal);
	return {
		readMaxBytes,
		writeMaxBytes,
		compressMinBytes
	};
}
/**
* Raise an error ResourceExhausted if more than writeMaxByte are written.
*
* @private Internal code, does not follow semantic versioning.
*/
function assertWriteMaxBytes(writeMaxBytes, bytesWritten) {
	if (bytesWritten > writeMaxBytes) throw new ConnectError(`message size ${bytesWritten} is larger than configured writeMaxBytes ${writeMaxBytes}`, Code.ResourceExhausted);
}
/**
* Raise an error ResourceExhausted if more than readMaxBytes are read.
*
* @private Internal code, does not follow semantic versioning.
*/
function assertReadMaxBytes(readMaxBytes, bytesRead, totalSizeKnown = false) {
	if (bytesRead > readMaxBytes) {
		let message = `message size is larger than configured readMaxBytes ${readMaxBytes}`;
		if (totalSizeKnown) message = `message size ${bytesRead} is larger than configured readMaxBytes ${readMaxBytes}`;
		throw new ConnectError(message, Code.ResourceExhausted);
	}
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol/envelope.js
/**
* Create an EnvelopeDecoder. The `readMaxBytes` argument limits the maximum
* size for individual messages.
*
* @private Internal code, does not follow semantic versioning.
*/
function createEnvelopeDecoder(readMaxBytes) {
	return new EnvelopeDecoderImpl(readMaxBytes);
}
var EnvelopeDecoderImpl = class {
	constructor(readMaxBytes) {
		this.readMaxBytes = readMaxBytes;
		this.header = /* @__PURE__ */ new Uint8Array(5);
		this.headerView = new DataView(this.header.buffer);
		this.buf = [];
	}
	get byteLength() {
		return this.buf.reduce((a, b) => a + b.byteLength, 0);
	}
	decode(chunk) {
		this.buf.push(chunk);
		const envs = [];
		for (;;) {
			let env = this.pop();
			if (!env) break;
			envs.push(env);
		}
		return envs;
	}
	pop() {
		if (!this.env) {
			this.env = this.head();
			if (!this.env) return;
		}
		if (this.cons(this.env.data)) {
			const env = this.env;
			this.env = void 0;
			return env;
		}
	}
	head() {
		if (!this.cons(this.header)) return;
		const flags = this.headerView.getUint8(0);
		const length = this.headerView.getUint32(1);
		assertReadMaxBytes(this.readMaxBytes, length, true);
		return {
			flags,
			data: new Uint8Array(length)
		};
	}
	cons(target) {
		const wantLength = target.byteLength;
		if (this.byteLength < wantLength) return false;
		let offset = 0;
		while (offset < wantLength) {
			const chunk = this.buf.shift();
			if (chunk.byteLength > wantLength - offset) {
				target.set(chunk.subarray(0, wantLength - offset), offset);
				this.buf.unshift(chunk.subarray(wantLength - offset));
				offset += wantLength - offset;
			} else {
				target.set(chunk, offset);
				offset += chunk.byteLength;
			}
		}
		return true;
	}
};
/**
* Create a WHATWG ReadableStream of enveloped messages from a ReadableStream
* of bytes.
*
* Ideally, this would simply be a TransformStream, but ReadableStream.pipeThrough
* does not have the necessary availability at this time.
*
* @private Internal code, does not follow semantic versioning.
*/
function createEnvelopeReadableStream(stream) {
	let reader;
	const buffer = createEnvelopeDecoder(4294967295);
	return new ReadableStream({
		start() {
			reader = stream.getReader();
		},
		async pull(controller) {
			let enqueuedOnce = false;
			while (!enqueuedOnce) {
				const result = await reader.read();
				if (result.done) {
					if (buffer.byteLength > 0) controller.error(new ConnectError("protocol error: incomplete envelope", Code.InvalidArgument));
					controller.close();
				} else for (const env of buffer.decode(result.value)) {
					controller.enqueue(env);
					enqueuedOnce = true;
				}
			}
		}
	});
}
/**
* Compress an EnvelopedMessage.
*
* Raises Internal if an enveloped message is already compressed.
*
* @private Internal code, does not follow semantic versioning.
*/
async function envelopeCompress(envelope, compression, compressMinBytes) {
	let { flags, data } = envelope;
	if ((flags & 1) === 1) throw new ConnectError("invalid envelope, already compressed", Code.Internal);
	if (compression && data.byteLength >= compressMinBytes) {
		data = await compression.compress(data);
		flags = flags | 1;
	}
	return {
		data,
		flags
	};
}
/**
* Decompress an EnvelopedMessage.
*
* Raises InvalidArgument if an envelope is compressed, but compression is null.
*
* Relies on the provided Compression to raise ResourceExhausted if the
* *decompressed* message size is larger than readMaxBytes. If the envelope is
* not compressed, readMaxBytes is not honored.
*
* @private Internal code, does not follow semantic versioning.
*/
async function envelopeDecompress(envelope, compression, readMaxBytes) {
	let { flags, data } = envelope;
	if ((flags & 1) === 1) {
		if (!compression) throw new ConnectError("received compressed envelope, but do not know how to decompress", Code.Internal);
		data = await compression.decompress(data, readMaxBytes);
		flags = flags ^ 1;
	}
	return {
		data,
		flags
	};
}
/**
* Encode a single enveloped message.
*
* @private Internal code, does not follow semantic versioning.
*/
function encodeEnvelope(flags, data) {
	const bytes = new Uint8Array(data.length + 5);
	bytes.set(data, 5);
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	v.setUint8(0, flags);
	v.setUint32(1, data.length);
	return bytes;
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol/async-iterable.js
var __asyncValues$4 = function(o) {
	if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
	var m = o[Symbol.asyncIterator], i;
	return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
		return this;
	}, i);
	function verb(n) {
		i[n] = o[n] && function(v) {
			return new Promise(function(resolve, reject) {
				v = o[n](v), settle(resolve, reject, v.done, v.value);
			});
		};
	}
	function settle(resolve, reject, d, v) {
		Promise.resolve(v).then(function(v) {
			resolve({
				value: v,
				done: d
			});
		}, reject);
	}
};
var __await$3 = function(v) {
	return this instanceof __await$3 ? (this.v = v, this) : new __await$3(v);
};
var __asyncGenerator$3 = function(thisArg, _arguments, generator) {
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
		r.value instanceof __await$3 ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r);
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
var __asyncDelegator$2 = function(o) {
	var i = {}, p;
	return verb("next"), verb("throw", function(e) {
		throw e;
	}), verb("return"), i[Symbol.iterator] = function() {
		return this;
	}, i;
	function verb(n, f) {
		i[n] = o[n] ? function(v) {
			return (p = !p) ? {
				value: __await$3(o[n](v)),
				done: false
			} : f ? f(v) : v;
		} : f;
	}
};
function pipeTo(source, ...rest) {
	const [transforms, sink, opt] = pickTransformsAndSink(rest);
	let iterable = source;
	let abortable;
	if ((opt === null || opt === void 0 ? void 0 : opt.propagateDownStreamError) === true) iterable = abortable = makeIterableAbortable(iterable);
	iterable = pipe(iterable, ...transforms, { propagateDownStreamError: false });
	return sink(iterable).catch((reason) => {
		if (abortable) return abortable.abort(reason).then(() => Promise.reject(reason));
		return Promise.reject(reason);
	});
}
function pickTransformsAndSink(rest) {
	let opt;
	if (typeof rest[rest.length - 1] != "function") opt = rest.pop();
	return [
		rest,
		rest.pop(),
		opt
	];
}
/**
* Creates an AsyncIterableSink that concatenates all chunks from the input into
* a single Uint8Array.
*
* The iterable raises an error if the more than readMaxBytes are read.
*
* An optional length hint can be provided to optimize allocation and validation.
* If more or less bytes are present in the source that the length hint indicates,
* and error is raised.
* If the length hint is larger than readMaxBytes, an error is raised.
* If the length hint is not a positive integer, it is ignored.
*
* @private Internal code, does not follow semantic versioning.
*/
function sinkAllBytes(readMaxBytes, lengthHint) {
	return async (iterable) => await readAllBytes(iterable, readMaxBytes, lengthHint);
}
function pipe(source, ...rest) {
	return __asyncGenerator$3(this, arguments, function* pipe_1() {
		var _a;
		const [transforms, opt] = pickTransforms(rest);
		let abortable;
		const sourceIt = source[Symbol.asyncIterator]();
		let iterable = { [Symbol.asyncIterator]() {
			return sourceIt;
		} };
		if ((opt === null || opt === void 0 ? void 0 : opt.propagateDownStreamError) === true) iterable = abortable = makeIterableAbortable(iterable);
		for (const t of transforms) iterable = t(iterable);
		const it = iterable[Symbol.asyncIterator]();
		try {
			for (;;) {
				const r = yield __await$3(it.next());
				if (r.done === true) break;
				if (!abortable) {
					yield yield __await$3(r.value);
					continue;
				}
				try {
					yield yield __await$3(r.value);
				} catch (e) {
					yield __await$3(abortable.abort(e));
					throw e;
				}
			}
		} finally {
			if ((opt === null || opt === void 0 ? void 0 : opt.propagateDownStreamError) === true) (_a = sourceIt.return) === null || _a === void 0 || _a.call(sourceIt).catch(() => {});
		}
	});
}
function pickTransforms(rest) {
	let opt;
	if (typeof rest[rest.length - 1] != "function") opt = rest.pop();
	return [rest, opt];
}
/**
* Creates an AsyncIterableTransform that catches any error from the input, and
* passes it to the given function. Unlike transformCatch(), the given function
* is also called when no error is raised.
*
* @private Internal code, does not follow semantic versioning.
*/
function transformCatchFinally(catchFinally) {
	return function(iterable) {
		return __asyncGenerator$3(this, arguments, function* () {
			let err;
			const it = iterable[Symbol.asyncIterator]();
			for (;;) {
				let r;
				try {
					r = yield __await$3(it.next());
				} catch (e) {
					err = e;
					break;
				}
				if (r.done === true) break;
				yield yield __await$3(r.value);
			}
			const caught = yield __await$3(catchFinally(err));
			if (caught !== void 0) yield yield __await$3(caught);
		});
	};
}
/**
* Creates an AsyncIterableTransform that prepends an element.
*
* The element to prepend is provided by a function. If the function returns
* undefined, no element is appended.
*
* @private Internal code, does not follow semantic versioning.
*/
function transformPrepend(provide) {
	return function(iterable) {
		return __asyncGenerator$3(this, arguments, function* () {
			var _a, e_3, _b, _c;
			const prepend = yield __await$3(provide());
			if (prepend !== void 0) yield yield __await$3(prepend);
			try {
				for (var _d = true, iterable_3 = __asyncValues$4(iterable), iterable_3_1; iterable_3_1 = yield __await$3(iterable_3.next()), _a = iterable_3_1.done, !_a; _d = true) {
					_c = iterable_3_1.value;
					_d = false;
					yield yield __await$3(_c);
				}
			} catch (e_3_1) {
				e_3 = { error: e_3_1 };
			} finally {
				try {
					if (!_d && !_a && (_b = iterable_3.return)) yield __await$3(_b.call(iterable_3));
				} finally {
					if (e_3) throw e_3.error;
				}
			}
		});
	};
}
function transformSerializeEnvelope(serialization, endStreamFlag, endSerialization) {
	if (endStreamFlag === void 0 || endSerialization === void 0) return function(iterable) {
		return __asyncGenerator$3(this, arguments, function* () {
			var _a, e_4, _b, _c;
			try {
				for (var _d = true, iterable_4 = __asyncValues$4(iterable), iterable_4_1; iterable_4_1 = yield __await$3(iterable_4.next()), _a = iterable_4_1.done, !_a; _d = true) {
					_c = iterable_4_1.value;
					_d = false;
					const chunk = _c;
					yield yield __await$3({
						flags: 0,
						data: serialization.serialize(chunk)
					});
				}
			} catch (e_4_1) {
				e_4 = { error: e_4_1 };
			} finally {
				try {
					if (!_d && !_a && (_b = iterable_4.return)) yield __await$3(_b.call(iterable_4));
				} finally {
					if (e_4) throw e_4.error;
				}
			}
		});
	};
	return function(iterable) {
		return __asyncGenerator$3(this, arguments, function* () {
			var _a, e_5, _b, _c;
			try {
				for (var _d = true, iterable_5 = __asyncValues$4(iterable), iterable_5_1; iterable_5_1 = yield __await$3(iterable_5.next()), _a = iterable_5_1.done, !_a; _d = true) {
					_c = iterable_5_1.value;
					_d = false;
					const chunk = _c;
					let data;
					let flags = 0;
					if (chunk.end) {
						flags = flags | endStreamFlag;
						data = endSerialization.serialize(chunk.value);
					} else data = serialization.serialize(chunk.value);
					yield yield __await$3({
						flags,
						data
					});
				}
			} catch (e_5_1) {
				e_5 = { error: e_5_1 };
			} finally {
				try {
					if (!_d && !_a && (_b = iterable_5.return)) yield __await$3(_b.call(iterable_5));
				} finally {
					if (e_5) throw e_5.error;
				}
			}
		});
	};
}
function transformParseEnvelope(serialization, endStreamFlag, endSerialization) {
	if (endSerialization && endStreamFlag !== void 0) return function(iterable) {
		return __asyncGenerator$3(this, arguments, function* () {
			var _a, e_6, _b, _c;
			try {
				for (var _d = true, iterable_6 = __asyncValues$4(iterable), iterable_6_1; iterable_6_1 = yield __await$3(iterable_6.next()), _a = iterable_6_1.done, !_a; _d = true) {
					_c = iterable_6_1.value;
					_d = false;
					const { flags, data } = _c;
					if ((flags & endStreamFlag) === endStreamFlag) yield yield __await$3({
						value: endSerialization.parse(data),
						end: true
					});
					else yield yield __await$3({
						value: serialization.parse(data),
						end: false
					});
				}
			} catch (e_6_1) {
				e_6 = { error: e_6_1 };
			} finally {
				try {
					if (!_d && !_a && (_b = iterable_6.return)) yield __await$3(_b.call(iterable_6));
				} finally {
					if (e_6) throw e_6.error;
				}
			}
		});
	};
	return function(iterable) {
		return __asyncGenerator$3(this, arguments, function* () {
			var _a, e_7, _b, _c;
			try {
				for (var _d = true, iterable_7 = __asyncValues$4(iterable), iterable_7_1; iterable_7_1 = yield __await$3(iterable_7.next()), _a = iterable_7_1.done, !_a; _d = true) {
					_c = iterable_7_1.value;
					_d = false;
					const { flags, data } = _c;
					if (endStreamFlag !== void 0 && (flags & endStreamFlag) === endStreamFlag) {
						if (endSerialization === null) throw new ConnectError("unexpected end flag", Code.InvalidArgument);
						continue;
					}
					yield yield __await$3(serialization.parse(data));
				}
			} catch (e_7_1) {
				e_7 = { error: e_7_1 };
			} finally {
				try {
					if (!_d && !_a && (_b = iterable_7.return)) yield __await$3(_b.call(iterable_7));
				} finally {
					if (e_7) throw e_7.error;
				}
			}
		});
	};
}
/**
* Creates an AsyncIterableTransform that takes enveloped messages as a source,
* and compresses them if they are larger than compressMinBytes.
*
* @private Internal code, does not follow semantic versioning.
*/
function transformCompressEnvelope(compression, compressMinBytes) {
	return function(iterable) {
		return __asyncGenerator$3(this, arguments, function* () {
			var _a, e_8, _b, _c;
			try {
				for (var _d = true, iterable_8 = __asyncValues$4(iterable), iterable_8_1; iterable_8_1 = yield __await$3(iterable_8.next()), _a = iterable_8_1.done, !_a; _d = true) {
					_c = iterable_8_1.value;
					_d = false;
					yield yield __await$3(yield __await$3(envelopeCompress(_c, compression, compressMinBytes)));
				}
			} catch (e_8_1) {
				e_8 = { error: e_8_1 };
			} finally {
				try {
					if (!_d && !_a && (_b = iterable_8.return)) yield __await$3(_b.call(iterable_8));
				} finally {
					if (e_8) throw e_8.error;
				}
			}
		});
	};
}
/**
* Creates an AsyncIterableTransform that takes enveloped messages as a source,
* and decompresses them using the given compression.
*
* The iterable raises an error if the decompressed payload of an enveloped
* message is larger than readMaxBytes, or if no compression is provided.
*
* @private Internal code, does not follow semantic versioning.
*/
function transformDecompressEnvelope(compression, readMaxBytes) {
	return function(iterable) {
		return __asyncGenerator$3(this, arguments, function* () {
			var _a, e_9, _b, _c;
			try {
				for (var _d = true, iterable_9 = __asyncValues$4(iterable), iterable_9_1; iterable_9_1 = yield __await$3(iterable_9.next()), _a = iterable_9_1.done, !_a; _d = true) {
					_c = iterable_9_1.value;
					_d = false;
					yield yield __await$3(yield __await$3(envelopeDecompress(_c, compression, readMaxBytes)));
				}
			} catch (e_9_1) {
				e_9 = { error: e_9_1 };
			} finally {
				try {
					if (!_d && !_a && (_b = iterable_9.return)) yield __await$3(_b.call(iterable_9));
				} finally {
					if (e_9) throw e_9.error;
				}
			}
		});
	};
}
/**
* Create an AsyncIterableTransform that takes enveloped messages as a source,
* and joins them into a stream of raw bytes.
*
* @private Internal code, does not follow semantic versioning.
*/
function transformJoinEnvelopes() {
	return function(iterable) {
		return __asyncGenerator$3(this, arguments, function* () {
			var _a, e_10, _b, _c;
			try {
				for (var _d = true, iterable_10 = __asyncValues$4(iterable), iterable_10_1; iterable_10_1 = yield __await$3(iterable_10.next()), _a = iterable_10_1.done, !_a; _d = true) {
					_c = iterable_10_1.value;
					_d = false;
					const { flags, data } = _c;
					yield yield __await$3(encodeEnvelope(flags, data));
				}
			} catch (e_10_1) {
				e_10 = { error: e_10_1 };
			} finally {
				try {
					if (!_d && !_a && (_b = iterable_10.return)) yield __await$3(_b.call(iterable_10));
				} finally {
					if (e_10) throw e_10.error;
				}
			}
		});
	};
}
/**
* Create an AsyncIterableTransform that takes raw bytes as a source, and splits
* them into enveloped messages.
*
* The iterable raises an error
* - if the payload of an enveloped message is larger than readMaxBytes,
* - if the stream ended before an enveloped message fully arrived,
* - or if the stream ended with extraneous data.
*
* @private Internal code, does not follow semantic versioning.
*/
function transformSplitEnvelope(readMaxBytes) {
	return function(iterable) {
		return __asyncGenerator$3(this, arguments, function* () {
			var _a, e_11, _b, _c;
			const buffer = createEnvelopeDecoder(readMaxBytes);
			try {
				for (var _d = true, iterable_11 = __asyncValues$4(iterable), iterable_11_1; iterable_11_1 = yield __await$3(iterable_11.next()), _a = iterable_11_1.done, !_a; _d = true) {
					_c = iterable_11_1.value;
					_d = false;
					const chunk = _c;
					for (const env of buffer.decode(chunk)) yield yield __await$3(env);
				}
			} catch (e_11_1) {
				e_11 = { error: e_11_1 };
			} finally {
				try {
					if (!_d && !_a && (_b = iterable_11.return)) yield __await$3(_b.call(iterable_11));
				} finally {
					if (e_11) throw e_11.error;
				}
			}
			if (buffer.byteLength > 0) throw new ConnectError("protocol error: incomplete envelope", Code.InvalidArgument);
		});
	};
}
/**
* Reads all bytes from the source, and concatenates them to a single Uint8Array.
*
* Raises an error if:
* - more than readMaxBytes are read
* - lengthHint is a positive integer, but larger than readMaxBytes
* - lengthHint is a positive integer, and the source contains more or less bytes
*   than promised
*
* @private Internal code, does not follow semantic versioning.
*/
async function readAllBytes(iterable, readMaxBytes, lengthHint) {
	var _a, e_12, _b, _c, _d, e_13, _e, _f;
	const [ok, hint] = parseLengthHint(lengthHint);
	if (ok) {
		if (hint > readMaxBytes) assertReadMaxBytes(readMaxBytes, hint, true);
		const buffer = new Uint8Array(hint);
		let offset = 0;
		try {
			for (var _g = true, iterable_12 = __asyncValues$4(iterable), iterable_12_1; iterable_12_1 = await iterable_12.next(), _a = iterable_12_1.done, !_a; _g = true) {
				_c = iterable_12_1.value;
				_g = false;
				const chunk = _c;
				if (offset + chunk.byteLength > hint) throw new ConnectError(`protocol error: promised ${hint} bytes, received ${offset + chunk.byteLength}`, Code.InvalidArgument);
				buffer.set(chunk, offset);
				offset += chunk.byteLength;
			}
		} catch (e_12_1) {
			e_12 = { error: e_12_1 };
		} finally {
			try {
				if (!_g && !_a && (_b = iterable_12.return)) await _b.call(iterable_12);
			} finally {
				if (e_12) throw e_12.error;
			}
		}
		if (offset < hint) throw new ConnectError(`protocol error: promised ${hint} bytes, received ${offset}`, Code.InvalidArgument);
		return buffer;
	}
	const chunks = [];
	let count = 0;
	try {
		for (var _h = true, iterable_13 = __asyncValues$4(iterable), iterable_13_1; iterable_13_1 = await iterable_13.next(), _d = iterable_13_1.done, !_d; _h = true) {
			_f = iterable_13_1.value;
			_h = false;
			const chunk = _f;
			count += chunk.byteLength;
			assertReadMaxBytes(readMaxBytes, count);
			chunks.push(chunk);
		}
	} catch (e_13_1) {
		e_13 = { error: e_13_1 };
	} finally {
		try {
			if (!_h && !_d && (_e = iterable_13.return)) await _e.call(iterable_13);
		} finally {
			if (e_13) throw e_13.error;
		}
	}
	const all = new Uint8Array(count);
	let offset = 0;
	for (let chunk = chunks.shift(); chunk; chunk = chunks.shift()) {
		all.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return all;
}
function parseLengthHint(lengthHint) {
	if (lengthHint === void 0 || lengthHint === null) return [false, 0];
	const n = typeof lengthHint == "string" ? parseInt(lengthHint, 10) : lengthHint;
	if (!Number.isSafeInteger(n) || n < 0) return [false, n];
	return [true, n];
}
/**
* Wait for the first element of an iterable without modifying the iterable.
* This consumes the first element, but pushes it back on the stack.
*
* @private Internal code, does not follow semantic versioning.
*/
async function untilFirst(iterable) {
	const it = iterable[Symbol.asyncIterator]();
	let first = await it.next();
	return { [Symbol.asyncIterator]() {
		const w = { async next() {
			if (first !== null) {
				const n = first;
				first = null;
				return n;
			}
			return await it.next();
		} };
		if (it.throw !== void 0) w.throw = (e) => it.throw(e);
		if (it.return !== void 0) w.return = (value) => it.return(value);
		return w;
	} };
}
/**
* Wrap the given iterable and return an iterable with an abort() method.
*
* This function exists purely for convenience. Where one would typically have
* to access the iterator directly, advance through all elements, and call
* AsyncIterator.throw() to notify the upstream iterable, this function allows
* to use convenient for-await loops and still notify the upstream iterable:
*
* ```ts
* const abortable = makeIterableAbortable(iterable);
* for await (const ele of abortable) {
*   await abortable.abort("ERR");
* }
* ```
* There are a couple of limitations of this function:
* - the given async iterable must implement throw
* - the async iterable cannot be re-use
* - if source catches errors and yields values for them, they are ignored, and
*   the source may still dangle
*
* There are four possible ways an async function* can handle yield errors:
* 1. don't catch errors at all - Abortable.abort() will resolve "rethrown"
* 2. catch errors and rethrow - Abortable.abort() will resolve "rethrown"
* 3. catch errors and return - Abortable.abort() will resolve "completed"
* 4. catch errors and yield a value - Abortable.abort() will resolve "caught"
*
* Note that catching errors and yielding a value is problematic, and it should
* be documented that this may leave the source in a dangling state.
*
* @private Internal code, does not follow semantic versioning.
*/
function makeIterableAbortable(iterable) {
	const innerCandidate = iterable[Symbol.asyncIterator]();
	if (innerCandidate.throw === void 0) throw new Error("AsyncIterable does not implement throw");
	const inner = innerCandidate;
	let aborted;
	let resultPromise;
	let it = {
		next() {
			resultPromise = inner.next().finally(() => {
				resultPromise = void 0;
			});
			return resultPromise;
		},
		throw(e) {
			return inner.throw(e);
		}
	};
	if (innerCandidate.return !== void 0) it = Object.assign(Object.assign({}, it), { return(value) {
		return inner.return(value);
	} });
	let used = false;
	return {
		abort(reason) {
			if (aborted) return aborted.state;
			const f = () => {
				return inner.throw(reason).then((r) => r.done === true ? "completed" : "caught", () => "rethrown");
			};
			if (resultPromise) {
				aborted = {
					reason,
					state: resultPromise.then(f, f)
				};
				return aborted.state;
			}
			aborted = {
				reason,
				state: f()
			};
			return aborted.state;
		},
		[Symbol.asyncIterator]() {
			if (used) throw new Error("AsyncIterable cannot be re-used");
			used = true;
			return it;
		}
	};
}
/**
* Create an asynchronous iterable from an array.
*
* @private Internal code, does not follow semantic versioning.
*/
function createAsyncIterable(items) {
	return __asyncGenerator$3(this, arguments, function* createAsyncIterable_1() {
		yield __await$3(yield* __asyncDelegator$2(__asyncValues$4(items)));
	});
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/callback-client.js
var __asyncValues$3 = function(o) {
	if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
	var m = o[Symbol.asyncIterator], i;
	return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
		return this;
	}, i);
	function verb(n) {
		i[n] = o[n] && function(v) {
			return new Promise(function(resolve, reject) {
				v = o[n](v), settle(resolve, reject, v.done, v.value);
			});
		};
	}
	function settle(resolve, reject, d, v) {
		Promise.resolve(v).then(function(v) {
			resolve({
				value: v,
				done: d
			});
		}, reject);
	}
};
/**
* Create a CallbackClient for the given service, invoking RPCs through the
* given transport.
*/
function createCallbackClient(service, transport) {
	return makeAnyClient(service, (method) => {
		switch (method.methodKind) {
			case "unary": return createUnaryFn$1(transport, method);
			case "server_streaming": return createServerStreamingFn$1(transport, method);
			default: return null;
		}
	});
}
function createUnaryFn$1(transport, method) {
	return (requestMessage, callback, options) => {
		const abort = new AbortController();
		options = wrapSignal(abort, options);
		transport.unary(method, abort.signal, options.timeoutMs, options.headers, requestMessage, options.contextValues).then((response) => {
			var _a, _b;
			(_a = options.onHeader) === null || _a === void 0 || _a.call(options, response.header);
			(_b = options.onTrailer) === null || _b === void 0 || _b.call(options, response.trailer);
			callback(void 0, response.message);
		}, (reason) => {
			const err = ConnectError.from(reason, Code.Internal);
			if (err.code === Code.Canceled && abort.signal.aborted) return;
			callback(err, create(method.output));
		});
		return () => abort.abort();
	};
}
function createServerStreamingFn$1(transport, method) {
	return (input, onResponse, onClose, options) => {
		const abort = new AbortController();
		async function run() {
			var _a, e_1, _b, _c;
			var _d, _e;
			options = wrapSignal(abort, options);
			const response = await transport.stream(method, options.signal, options.timeoutMs, options.headers, createAsyncIterable([input]), options.contextValues);
			(_d = options.onHeader) === null || _d === void 0 || _d.call(options, response.header);
			try {
				for (var _f = true, _g = __asyncValues$3(response.message), _h; _h = await _g.next(), _a = _h.done, !_a; _f = true) {
					_c = _h.value;
					_f = false;
					onResponse(_c);
				}
			} catch (e_1_1) {
				e_1 = { error: e_1_1 };
			} finally {
				try {
					if (!_f && !_a && (_b = _g.return)) await _b.call(_g);
				} finally {
					if (e_1) throw e_1.error;
				}
			}
			(_e = options.onTrailer) === null || _e === void 0 || _e.call(options, response.trailer);
			onClose(void 0);
		}
		run().catch((reason) => {
			const err = ConnectError.from(reason, Code.Internal);
			if (err.code === Code.Canceled && abort.signal.aborted) onClose(void 0);
			else onClose(err);
		});
		return () => abort.abort();
	};
}
function wrapSignal(abort, options) {
	if (options === null || options === void 0 ? void 0 : options.signal) {
		options.signal.addEventListener("abort", () => abort.abort());
		if (options.signal.aborted) abort.abort();
	}
	return Object.assign(Object.assign({}, options), { signal: abort.signal });
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/promise-client.js
var __asyncValues$2 = function(o) {
	if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
	var m = o[Symbol.asyncIterator], i;
	return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
		return this;
	}, i);
	function verb(n) {
		i[n] = o[n] && function(v) {
			return new Promise(function(resolve, reject) {
				v = o[n](v), settle(resolve, reject, v.done, v.value);
			});
		};
	}
	function settle(resolve, reject, d, v) {
		Promise.resolve(v).then(function(v) {
			resolve({
				value: v,
				done: d
			});
		}, reject);
	}
};
var __await$2 = function(v) {
	return this instanceof __await$2 ? (this.v = v, this) : new __await$2(v);
};
var __asyncDelegator$1 = function(o) {
	var i = {}, p;
	return verb("next"), verb("throw", function(e) {
		throw e;
	}), verb("return"), i[Symbol.iterator] = function() {
		return this;
	}, i;
	function verb(n, f) {
		i[n] = o[n] ? function(v) {
			return (p = !p) ? {
				value: __await$2(o[n](v)),
				done: false
			} : f ? f(v) : v;
		} : f;
	}
};
var __asyncGenerator$2 = function(thisArg, _arguments, generator) {
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
		r.value instanceof __await$2 ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r);
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
/**
* Create a Client for the given service, invoking RPCs through the
* given transport.
*/
function createClient(service, transport) {
	return makeAnyClient(service, (method) => {
		switch (method.methodKind) {
			case "unary": return createUnaryFn(transport, method);
			case "server_streaming": return createServerStreamingFn(transport, method);
			case "client_streaming": return createClientStreamingFn(transport, method);
			case "bidi_streaming": return createBiDiStreamingFn(transport, method);
			default: return null;
		}
	});
}
function createUnaryFn(transport, method) {
	return async (input, options) => {
		var _a, _b;
		const response = await transport.unary(method, options === null || options === void 0 ? void 0 : options.signal, options === null || options === void 0 ? void 0 : options.timeoutMs, options === null || options === void 0 ? void 0 : options.headers, input, options === null || options === void 0 ? void 0 : options.contextValues);
		(_a = options === null || options === void 0 ? void 0 : options.onHeader) === null || _a === void 0 || _a.call(options, response.header);
		(_b = options === null || options === void 0 ? void 0 : options.onTrailer) === null || _b === void 0 || _b.call(options, response.trailer);
		return response.message;
	};
}
function createServerStreamingFn(transport, method) {
	return (input, options) => handleStreamResponse(transport.stream(method, options === null || options === void 0 ? void 0 : options.signal, options === null || options === void 0 ? void 0 : options.timeoutMs, options === null || options === void 0 ? void 0 : options.headers, createAsyncIterable([input]), options === null || options === void 0 ? void 0 : options.contextValues), options);
}
function createClientStreamingFn(transport, method) {
	return async (request, options) => {
		var _a, e_1, _b, _c;
		var _d, _e;
		const response = await transport.stream(method, options === null || options === void 0 ? void 0 : options.signal, options === null || options === void 0 ? void 0 : options.timeoutMs, options === null || options === void 0 ? void 0 : options.headers, request, options === null || options === void 0 ? void 0 : options.contextValues);
		(_d = options === null || options === void 0 ? void 0 : options.onHeader) === null || _d === void 0 || _d.call(options, response.header);
		let singleMessage;
		let count = 0;
		try {
			for (var _f = true, _g = __asyncValues$2(response.message), _h; _h = await _g.next(), _a = _h.done, !_a; _f = true) {
				_c = _h.value;
				_f = false;
				singleMessage = _c;
				count++;
			}
		} catch (e_1_1) {
			e_1 = { error: e_1_1 };
		} finally {
			try {
				if (!_f && !_a && (_b = _g.return)) await _b.call(_g);
			} finally {
				if (e_1) throw e_1.error;
			}
		}
		if (!singleMessage) throw new ConnectError("protocol error: missing response message", Code.Unimplemented);
		if (count > 1) throw new ConnectError("protocol error: received extra messages for client streaming method", Code.Unimplemented);
		(_e = options === null || options === void 0 ? void 0 : options.onTrailer) === null || _e === void 0 || _e.call(options, response.trailer);
		return singleMessage;
	};
}
function createBiDiStreamingFn(transport, method) {
	return (request, options) => handleStreamResponse(transport.stream(method, options === null || options === void 0 ? void 0 : options.signal, options === null || options === void 0 ? void 0 : options.timeoutMs, options === null || options === void 0 ? void 0 : options.headers, request, options === null || options === void 0 ? void 0 : options.contextValues), options);
}
function handleStreamResponse(stream, options) {
	const it = (function() {
		return __asyncGenerator$2(this, arguments, function* () {
			var _a, _b;
			const response = yield __await$2(stream);
			(_a = options === null || options === void 0 ? void 0 : options.onHeader) === null || _a === void 0 || _a.call(options, response.header);
			yield __await$2(yield* __asyncDelegator$1(__asyncValues$2(response.message)));
			(_b = options === null || options === void 0 ? void 0 : options.onTrailer) === null || _b === void 0 || _b.call(options, response.trailer);
		});
	})()[Symbol.asyncIterator]();
	return { [Symbol.asyncIterator]: () => ({ next: () => it.next() }) };
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol/signals.js
/**
* Create an AbortController that is automatically aborted if one of the given
* signals is aborted.
*
* For convenience, the linked AbortSignals can be undefined.
*
* If the controller or any of the signals is aborted, all event listeners are
* removed.
*
* @private Internal code, does not follow semantic versioning.
*/
function createLinkedAbortController(...signals) {
	const controller = new AbortController();
	const sa = signals.filter((s) => s !== void 0).concat(controller.signal);
	for (const signal of sa) {
		if (signal.aborted) {
			onAbort.apply(signal);
			break;
		}
		signal.addEventListener("abort", onAbort);
	}
	function onAbort() {
		if (!controller.signal.aborted) controller.abort(getAbortSignalReason(this));
		for (const signal of sa) signal.removeEventListener("abort", onAbort);
	}
	return controller;
}
/**
* Create a deadline signal. The returned object contains an AbortSignal, but
* also a cleanup function to stop the timer, which must be called once the
* calling code is no longer interested in the signal.
*
* Ideally, we would simply use AbortSignal.timeout(), but it is not widely
* available yet.
*
* @private Internal code, does not follow semantic versioning.
*/
function createDeadlineSignal(timeoutMs) {
	const controller = new AbortController();
	const listener = () => {
		controller.abort(new ConnectError("the operation timed out", Code.DeadlineExceeded));
	};
	let timeoutId;
	if (timeoutMs !== void 0) {
		if (timeoutMs <= 0) listener();
		else timeoutId = setTimeout(listener, timeoutMs);
	}
	return {
		signal: controller.signal,
		cleanup: () => clearTimeout(timeoutId)
	};
}
/**
* Returns the reason why an AbortSignal was aborted. Returns undefined if the
* signal has not been aborted.
*
* The property AbortSignal.reason is not widely available. This function
* returns an AbortError if the signal is aborted, but reason is undefined.
*
* @private Internal code, does not follow semantic versioning.
*/
function getAbortSignalReason(signal) {
	if (!signal.aborted) return;
	if (signal.reason !== void 0) return signal.reason;
	const e = /* @__PURE__ */ new Error("This operation was aborted");
	e.name = "AbortError";
	return e;
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/context-values.js
/**
* createContextValues creates a new ContextValues.
*/
function createContextValues() {
	return {
		get(key) {
			return key.id in this ? this[key.id] : key.defaultValue;
		},
		set(key, value) {
			this[key.id] = value;
			return this;
		},
		delete(key) {
			delete this[key.id];
			return this;
		}
	};
}
/**
* createContextKey creates a new ContextKey.
*/
function createContextKey(defaultValue, options) {
	return {
		id: Symbol(options === null || options === void 0 ? void 0 : options.description),
		defaultValue
	};
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/implementation.js
/**
* Create a new HandlerContext.
*
* The context is usually automatically created by handlers, but if a service
* implementation is used in unit tests, this function can be used to create
* a context.
*/
function createHandlerContext(init) {
	var _a;
	let timeoutMs;
	if (init.timeoutMs !== void 0) {
		const date = new Date(Date.now() + init.timeoutMs);
		timeoutMs = () => date.getTime() - Date.now();
	} else timeoutMs = () => void 0;
	const deadline = createDeadlineSignal(init.timeoutMs);
	const abortController = createLinkedAbortController(deadline.signal, init.requestSignal, init.shutdownSignal);
	return Object.assign(Object.assign({}, init), {
		signal: abortController.signal,
		timeoutMs,
		requestHeader: new Headers(init.requestHeader),
		responseHeader: new Headers(init.responseHeader),
		responseTrailer: new Headers(init.responseTrailer),
		abort(reason) {
			deadline.cleanup();
			abortController.abort(reason);
		},
		values: (_a = init.contextValues) !== null && _a !== void 0 ? _a : createContextValues()
	});
}
/**
* Create an MethodImplSpec - a user-provided implementation for a method,
* wrapped in a discriminated union type along with service and method metadata.
*/
function createMethodImplSpec(method, impl) {
	return {
		kind: method.methodKind,
		method,
		impl
	};
}
/**
* Create an ServiceImplSpec - a user-provided service implementation wrapped
* with metadata.
*/
function createServiceImplSpec(service, impl) {
	const s = {
		service,
		methods: {}
	};
	for (const method of service.methods) {
		let fn = impl[method.localName];
		if (typeof fn == "function") fn = fn.bind(impl);
		else {
			const message = `${service.typeName}.${method.name} is not implemented`;
			fn = function unimplemented() {
				throw new ConnectError(message, Code.Unimplemented);
			};
		}
		s.methods[method.localName] = createMethodImplSpec(method, fn);
	}
	return s;
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-grpc-web/trailer.js
/**
* Parse a gRPC-web trailer, a set of header fields separated by CRLF.
*
* @private Internal code, does not follow semantic versioning.
*/
function trailerParse(data) {
	const headers = new Headers();
	const lines = new TextDecoder().decode(data).split("\r\n");
	for (const line of lines) {
		if (line === "") continue;
		const i = line.indexOf(":");
		if (i > 0) {
			const name = line.substring(0, i).trim();
			const value = line.substring(i + 1).trim();
			headers.append(name, value);
		}
	}
	return headers;
}
/**
* Serialize a Headers object as a gRPC-web trailer.
*
* @private Internal code, does not follow semantic versioning.
*/
function trailerSerialize(trailer) {
	const lines = [];
	trailer.forEach((value, key) => {
		lines.push(`${key}: ${value}\r\n`);
	});
	return new TextEncoder().encode(lines.join(""));
}
/**
* Create a Serialization object that serializes a gRPC-web trailer, a Headers
* object that is serialized as a set of header fields, separated by CRLF.
*
* @private Internal code, does not follow semantic versioning.
*/
function createTrailerSerialization() {
	return {
		serialize: trailerSerialize,
		parse: trailerParse
	};
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-grpc/headers.js
/**
* @private Internal code, does not follow semantic versioning.
*/
var headerContentType$1 = "Content-Type";
var headerEncoding = "Grpc-Encoding";
var headerAcceptEncoding = "Grpc-Accept-Encoding";
var headerTimeout$1 = "Grpc-Timeout";
var headerGrpcStatus = "Grpc-Status";
var headerGrpcMessage = "Grpc-Message";
var headerGrpcDetails = "Grpc-Status-Details-Bin";
var headerStatusDetailsBin = "Grpc-Status-Details-Bin";
var headerMessageType = "Grpc-Message-Type";
var headerUserAgent$1 = "User-Agent";
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-grpc-web/headers.js
/**
* gRPC-web does not use the standard header User-Agent.
*
* @private Internal code, does not follow semantic versioning.
*/
var headerXUserAgent = "X-User-Agent";
/**
* The canonical grpc/grpc-web JavaScript implementation sets
* this request header with value "1".
* Some servers may rely on the header to identify gRPC-web
* requests. For example the proxy by improbable:
* https://github.com/improbable-eng/grpc-web/blob/53aaf4cdc0fede7103c1b06f0cfc560c003a5c41/go/grpcweb/wrapper.go#L231
*
* @private Internal code, does not follow semantic versioning.
*/
var headerXGrpcWeb = "X-Grpc-Web";
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-grpc-web/content-type.js
/**
* Regular Expression that matches any valid gRPC-web Content-Type header value.
* Note that this includes application/grpc-web-text with the additional base64
* encoding.
*
* @private Internal code, does not follow semantic versioning.
*/
var contentTypeRegExp$2 = /^application\/grpc-web(-text)?(?:\+(?:(json)(?:; ?charset=utf-?8)?|proto))?$/i;
var contentTypeProto$1 = "application/grpc-web+proto";
var contentTypeJson$1 = "application/grpc-web+json";
/**
* Parse a gRPC-web Content-Type header value.
*
* @private Internal code, does not follow semantic versioning.
*/
function parseContentType$2(contentType) {
	const match = contentType === null || contentType === void 0 ? void 0 : contentType.match(contentTypeRegExp$2);
	if (!match) return;
	return {
		text: !!match[1],
		binary: !match[2]
	};
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-grpc/parse-timeout.js
/**
* Parse a gRPC Timeout (Deadline) header.
*
* @private Internal code, does not follow semantic versioning.
*/
function parseTimeout$1(value, maxTimeoutMs) {
	if (value === null) return {};
	const results = /^(\d{1,8})([HMSmun])$/.exec(value);
	if (results === null) return { error: new ConnectError(`protocol error: invalid grpc timeout value: ${value}`, Code.InvalidArgument) };
	const timeoutMs = {
		H: 36e5,
		M: 6e4,
		S: 1e3,
		m: 1,
		u: .001,
		n: 1e-6
	}[results[2]] * parseInt(results[1]);
	if (timeoutMs > maxTimeoutMs) return {
		timeoutMs,
		error: new ConnectError(`timeout ${timeoutMs}ms must be <= ${maxTimeoutMs}`, Code.InvalidArgument)
	};
	return { timeoutMs };
}
/**
* Describes the message google.rpc.Status.
* Use `create(StatusSchema)` to create a new message.
*/
var StatusSchema = /*@__PURE__*/ messageDesc(/* @__PURE__ */ fileDesc("CgxzdGF0dXMucHJvdG8SCmdvb2dsZS5ycGMiTgoGU3RhdHVzEgwKBGNvZGUYASABKAUSDwoHbWVzc2FnZRgCIAEoCRIlCgdkZXRhaWxzGAMgAygLMhQuZ29vZ2xlLnByb3RvYnVmLkFueUJeCg5jb20uZ29vZ2xlLnJwY0ILU3RhdHVzUHJvdG9QAVo3Z29vZ2xlLmdvbGFuZy5vcmcvZ2VucHJvdG8vZ29vZ2xlYXBpcy9ycGMvc3RhdHVzO3N0YXR1c6ICA1JQQ2IGcHJvdG8z", [file_google_protobuf_any]), 0);
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-connect/headers.js
/**
* @private Internal code, does not follow semantic versioning.
*/
var headerContentType = "Content-Type";
var headerUnaryContentLength = "Content-Length";
var headerUnaryEncoding = "Content-Encoding";
var headerStreamEncoding = "Connect-Content-Encoding";
var headerUnaryAcceptEncoding = "Accept-Encoding";
var headerStreamAcceptEncoding = "Connect-Accept-Encoding";
var headerTimeout = "Connect-Timeout-Ms";
var headerProtocolVersion = "Connect-Protocol-Version";
var headerDate = "Date";
var headerHost = "Host";
var headerTrailer = "Trailer";
var headerUserAgent = "User-Agent";
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol/protocol-headers.js
/**
* The set of HTTP header names that carry protocol-level information for the
* Connect, gRPC, and gRPC-Web protocols. These are reserved by the protocol
* implementation and are not considered user metadata.
*
* Mirrors protocolHeaders in connect-go. Any changes to this constant must be
* made there first.
*
* @private Internal code, does not follow semantic versioning.
*/
var protocolHeaders = new Set([
	headerContentType,
	headerUnaryContentLength,
	headerUnaryEncoding,
	headerHost,
	headerUserAgent,
	headerTrailer,
	headerDate,
	headerUnaryAcceptEncoding,
	"Trailer-",
	headerStreamEncoding,
	headerStreamAcceptEncoding,
	headerTimeout,
	headerProtocolVersion,
	headerEncoding,
	headerAcceptEncoding,
	headerTimeout$1,
	headerGrpcStatus,
	headerGrpcMessage,
	headerGrpcDetails
].map((name) => name.toLowerCase()));
/**
* Append all headers from `from` into `into`, skipping any protocol headers.
*
* Mirrors mergeNonProtocolHeaders in connect-go. Any changes to this method must be
* made there first.
*
* @private Internal code, does not follow semantic versioning.
*/
function mergeNonProtocolHeaders(into, from) {
	from.forEach((value, key) => {
		if (!protocolHeaders.has(key.toLowerCase())) into.append(key, value);
	});
}
/**
* Sets the fields "grpc-status" and "grpc-message" in the given
* Headers object.
* If an error is given and contains error details, the function
* will also set the field "grpc-status-details-bin" with an encoded
* google.rpc.Status message including the error details.
*
* @private Internal code, does not follow semantic versioning.
*/
function setTrailerStatus(target, error) {
	if (error) {
		if (!error.isWireError) mergeNonProtocolHeaders(target, error.metadata);
		target.set(headerGrpcStatus, error.code.toString(10));
		target.set(headerGrpcMessage, encodeURIComponent(error.rawMessage));
		if (error.details.length > 0) {
			const status = create(StatusSchema, {
				code: error.code,
				message: error.rawMessage,
				details: error.details.map((detail) => "desc" in detail ? anyPack(detail.desc, create(detail.desc, detail.value)) : {
					typeUrl: `type.googleapis.com/${detail.type}`,
					value: detail.value
				})
			});
			target.set(headerStatusDetailsBin, encodeBinaryHeader(status, StatusSchema));
		}
	} else target.set(headerGrpcStatus, "0".toString());
	return target;
}
/**
* Find an error status in the given Headers object, which can be either
* a trailer, or a header (as allowed for so-called trailers-only responses).
* The field "grpc-status-details-bin" is inspected, and if not present,
* the fields "grpc-status" and "grpc-message" are used.
* Returns an error only if the gRPC status code is > 0.
*
* @private Internal code, does not follow semantic versioning.
*/
function findTrailerError(headerOrTrailer) {
	var _a;
	const statusBytes = headerOrTrailer.get(headerStatusDetailsBin);
	if (statusBytes != null) {
		const status = decodeBinaryHeader(statusBytes, StatusSchema);
		if (status.code == 0) return;
		const error = new ConnectError(status.message, status.code, headerOrTrailer);
		error.details = status.details.map((any) => ({
			type: any.typeUrl.substring(any.typeUrl.lastIndexOf("/") + 1),
			value: any.value
		}));
		error.isWireError = true;
		return error;
	}
	const grpcStatus = headerOrTrailer.get(headerGrpcStatus);
	if (grpcStatus != null) {
		if (grpcStatus === "0") return;
		const code = parseInt(grpcStatus, 10);
		let error;
		if (code in Code) error = new ConnectError(decodeURIComponent((_a = headerOrTrailer.get("Grpc-Message")) !== null && _a !== void 0 ? _a : ""), code, headerOrTrailer);
		else error = new ConnectError(`invalid grpc-status: ${grpcStatus}`, Code.Internal, headerOrTrailer);
		error.isWireError = true;
		return error;
	}
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol/content-type-matcher.js
var contentTypeMatcherCacheSize = 1024;
/**
* Create a function that returns true if the given mime type is supported.
* A mime type is supported when one of the regular expressions match.
*
* @private Internal code, does not follow semantic versioning.
*/
function contentTypeMatcher(...supported) {
	const cache = /* @__PURE__ */ new Map();
	const source = supported.reduce((previousValue, currentValue) => previousValue.concat("supported" in currentValue ? currentValue.supported : currentValue), []);
	function match(contentType) {
		if (contentType === null || contentType.length == 0) return false;
		const cached = cache.get(contentType);
		if (cached !== void 0) return cached;
		const ok = source.some((re) => re.test(contentType));
		if (cache.size < contentTypeMatcherCacheSize) cache.set(contentType, ok);
		return ok;
	}
	match.supported = source;
	return match;
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol/create-method-url.js
/**
* Create a URL for the given RPC. This simply adds the qualified
* service name, a slash, and the method name to the path of the given
* baseUrl.
*
* For example, the baseUri https://example.com and method "Say" from
* the service example.ElizaService results in:
* https://example.com/example.ElizaService/Say
*
* This format is used by the protocols Connect, gRPC and Twirp.
*
* Note that this function also accepts a protocol-relative baseUrl.
* If given an empty string or "/" as a baseUrl, it returns just the
* path.
*/
function createMethodUrl(baseUrl, method) {
	return baseUrl.toString().replace(/\/?$/, `/${method.parent.typeName}/${method.name}`);
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol/normalize.js
/**
*  Takes a partial protobuf messages of the
*  specified message type as input, and returns full instances.
*/
function normalize(desc, message) {
	return create(desc, message);
}
/**
* Takes an AsyncIterable of partial protobuf messages of the
* specified message type as input, and yields full instances.
*/
function normalizeIterable(desc, input) {
	function transform(result) {
		if (result.done === true) return result;
		return {
			done: result.done,
			value: normalize(desc, result.value)
		};
	}
	return { [Symbol.asyncIterator]() {
		const it = input[Symbol.asyncIterator]();
		const res = { next: () => it.next().then(transform) };
		if (it.throw !== void 0) res.throw = (e) => it.throw(e).then(transform);
		if (it.return !== void 0) res.return = (v) => it.return(v).then(transform);
		return res;
	} };
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/interceptor.js
/**
* applyInterceptors takes the given UnaryFn or ServerStreamingFn, and wraps
* it with each of the given interceptors, returning a new UnaryFn or
* ServerStreamingFn.
*/
function applyInterceptors(next, interceptors) {
	if (!interceptors) return next;
	for (const i of interceptors.concat().reverse()) next = i(next);
	return next;
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol/invoke-implementation.js
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
var __asyncValues$1 = function(o) {
	if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
	var m = o[Symbol.asyncIterator], i;
	return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
		return this;
	}, i);
	function verb(n) {
		i[n] = o[n] && function(v) {
			return new Promise(function(resolve, reject) {
				v = o[n](v), settle(resolve, reject, v.done, v.value);
			});
		};
	}
	function settle(resolve, reject, d, v) {
		Promise.resolve(v).then(function(v) {
			resolve({
				value: v,
				done: d
			});
		}, reject);
	}
};
var __asyncDelegator = function(o) {
	var i = {}, p;
	return verb("next"), verb("throw", function(e) {
		throw e;
	}), verb("return"), i[Symbol.iterator] = function() {
		return this;
	}, i;
	function verb(n, f) {
		i[n] = o[n] ? function(v) {
			return (p = !p) ? {
				value: __await$1(o[n](v)),
				done: false
			} : f ? f(v) : v;
		} : f;
	}
};
/**
* Invoke the implementation for a streaming RPC, unless a request gate rejects
* the call first.
*
* The gate runs before the request body is received. If it throws, the returned
* iterator rejects with its error, so the caller's response pipeline serializes
* it without reading the body; otherwise the implementation's iterator is
* returned.
*
* @private Internal code, does not follow semantic versioning.
*/
async function applyRequestGate(context, requestGate, invoke) {
	if (requestGate !== void 0) try {
		await requestGate(context);
	} catch (reason) {
		return { next: () => Promise.reject(reason) };
	}
	return invoke()[Symbol.asyncIterator]();
}
/**
* Invoke a user-provided implementation of a unary RPC. Returns a normalized
* output message.
*
* @private Internal code, does not follow semantic versioning.
*/
async function invokeUnaryImplementation(spec, context, input, interceptors) {
	const anyFn = async (req) => {
		return Object.assign({
			message: normalize(spec.method.output, await spec.impl(req.message, mergeRequest(context, req))),
			stream: false,
			method: spec.method
		}, responseCommon(context, spec));
	};
	const { message, header, trailer } = await applyInterceptors(anyFn, interceptors)(Object.assign({
		stream: false,
		message: input,
		method: spec.method
	}, requestCommon(context, spec)));
	copyHeaders(header, context.responseHeader);
	copyHeaders(trailer, context.responseTrailer);
	return message;
}
/**
* Return an AsyncIterableTransform that invokes a user-provided implementation,
* giving it input from an asynchronous iterable, and returning its output as an
* asynchronous iterable.
*
* @private Internal code, does not follow semantic versioning.
*/
function transformInvokeImplementation(spec, context, interceptors) {
	switch (spec.kind) {
		case "unary": return function unary(input) {
			return __asyncGenerator$1(this, arguments, function* unary_1() {
				yield yield __await$1(yield __await$1(invokeUnaryImplementation(spec, context, yield __await$1(ensureSingle(input, "unary")), interceptors)));
			});
		};
		case "server_streaming": return function serverStreaming(input) {
			return invokeStreamImplementation(spec, context, input, interceptors, async (req) => {
				const output = normalizeIterable(spec.method.output, spec.impl(await ensureSingle(req.message, "server-streaming"), mergeRequest(context, req)));
				return Object.assign({
					stream: true,
					message: output,
					method: spec.method
				}, responseCommon(context, spec));
			});
		};
		case "client_streaming": return function clientStreaming(input) {
			return invokeStreamImplementation(spec, context, input, interceptors, async (req) => {
				return Object.assign({
					message: createAsyncIterable([normalize(spec.method.output, await spec.impl(req.message, mergeRequest(context, req)))]),
					stream: true,
					method: spec.method
				}, responseCommon(context, spec));
			});
		};
		case "bidi_streaming": return function biDiStreaming(input) {
			return invokeStreamImplementation(spec, context, input, interceptors, (req) => {
				return Promise.resolve(Object.assign({
					message: normalizeIterable(spec.method.output, spec.impl(req.message, mergeRequest(context, req))),
					stream: true,
					method: spec.method
				}, responseCommon(context, spec)));
			});
		};
	}
}
function invokeStreamImplementation(spec, context, input, interceptors, anyFn) {
	return __asyncGenerator$1(this, arguments, function* invokeStreamImplementation_1() {
		const { message, header, trailer } = yield __await$1(applyInterceptors(anyFn, interceptors)(Object.assign({
			stream: true,
			message: input,
			method: spec.method
		}, requestCommon(context, spec))));
		copyHeaders(header, context.responseHeader);
		yield __await$1(yield* __asyncDelegator(__asyncValues$1(message)));
		copyHeaders(trailer, context.responseTrailer);
	});
}
async function ensureSingle(iterable, method) {
	const it = iterable[Symbol.asyncIterator]();
	const first = await it.next();
	if (first.done === true) throw new ConnectError(`protocol error: missing input message for ${method} method`, Code.Unimplemented);
	if ((await it.next()).done !== true) throw new ConnectError(`protocol error: received extra input message for ${method} method`, Code.Unimplemented);
	return first.value;
}
function requestCommon(context, spec) {
	return {
		requestMethod: context.requestMethod,
		url: context.url,
		signal: context.signal,
		header: context.requestHeader,
		service: spec.method.parent,
		contextValues: context.values
	};
}
function responseCommon(context, spec) {
	return {
		service: spec.method.parent,
		header: context.responseHeader,
		trailer: context.responseTrailer
	};
}
function mergeRequest(context, req) {
	return Object.assign(Object.assign({}, context), {
		service: req.service,
		requestHeader: req.header,
		signal: req.signal,
		values: req.contextValues
	});
}
function copyHeaders(from, to) {
	if (from === to) return;
	to.forEach((_, key) => {
		to.delete(key);
	});
	from.forEach((value, key) => {
		to.set(key, value);
	});
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol/serialization.js
/**
* Sets default JSON serialization options for connect-es.
*
* With standard protobuf JSON serialization, unknown JSON fields are
* rejected by default. In connect-es, unknown JSON fields are ignored
* by default.
*/
function getJsonOptions(options) {
	var _a;
	const o = Object.assign({}, options);
	(_a = o.ignoreUnknownFields) !== null && _a !== void 0 || (o.ignoreUnknownFields = true);
	return o;
}
/**
* Create an object that provides convenient access to request and response
* message serialization for a given method.
*
* @private Internal code, does not follow semantic versioning.
*/
function createMethodSerializationLookup(method, binaryOptions, jsonOptions, limitOptions) {
	const inputBinary = limitSerialization(createBinarySerialization(method.input, binaryOptions), limitOptions);
	const inputJson = limitSerialization(createJsonSerialization(method.input, jsonOptions), limitOptions);
	const outputBinary = limitSerialization(createBinarySerialization(method.output, binaryOptions), limitOptions);
	const outputJson = limitSerialization(createJsonSerialization(method.output, jsonOptions), limitOptions);
	return {
		getI(useBinaryFormat) {
			return useBinaryFormat ? inputBinary : inputJson;
		},
		getO(useBinaryFormat) {
			return useBinaryFormat ? outputBinary : outputJson;
		}
	};
}
/**
* Returns functions to normalize and serialize the input message
* of an RPC, and to parse the output message of an RPC.
*
* @private Internal code, does not follow semantic versioning.
*/
function createClientMethodSerializers(method, useBinaryFormat, jsonOptions, binaryOptions) {
	const input = useBinaryFormat ? createBinarySerialization(method.input, binaryOptions) : createJsonSerialization(method.input, jsonOptions);
	return {
		parse: (useBinaryFormat ? createBinarySerialization(method.output, binaryOptions) : createJsonSerialization(method.output, jsonOptions)).parse,
		serialize: input.serialize
	};
}
/**
* Apply I/O limits to a Serialization object, returning a new object.
*
* @private Internal code, does not follow semantic versioning.
*/
function limitSerialization(serialization, limitOptions) {
	return {
		serialize(data) {
			const bytes = serialization.serialize(data);
			assertWriteMaxBytes(limitOptions.writeMaxBytes, bytes.byteLength);
			return bytes;
		},
		parse(data) {
			assertReadMaxBytes(limitOptions.readMaxBytes, data.byteLength, true);
			return serialization.parse(data);
		}
	};
}
/**
* Creates a Serialization object for serializing the given protobuf message
* with the protobuf binary format.
*/
function createBinarySerialization(desc, options) {
	return {
		parse(data) {
			try {
				return fromBinary(desc, data, options);
			} catch (e) {
				throw new ConnectError(`parse binary: ${e instanceof Error ? e.message : String(e)}`, Code.Internal);
			}
		},
		serialize(data) {
			try {
				return toBinary(desc, data, options);
			} catch (e) {
				throw new ConnectError(`serialize binary: ${e instanceof Error ? e.message : String(e)}`, Code.Internal);
			}
		}
	};
}
/**
* Creates a Serialization object for serializing the given protobuf message
* with the protobuf canonical JSON encoding.
*
* By default, unknown fields are ignored.
*/
function createJsonSerialization(desc, options) {
	var _a, _b;
	const textEncoder = (_a = options === null || options === void 0 ? void 0 : options.textEncoder) !== null && _a !== void 0 ? _a : new TextEncoder();
	const textDecoder = (_b = options === null || options === void 0 ? void 0 : options.textDecoder) !== null && _b !== void 0 ? _b : new TextDecoder();
	const o = getJsonOptions(options);
	return {
		parse(data) {
			try {
				return fromJsonString(desc, textDecoder.decode(data), o);
			} catch (e) {
				throw ConnectError.from(e, Code.InvalidArgument);
			}
		},
		serialize(data) {
			try {
				const json = toJsonString(desc, data, o);
				return textEncoder.encode(json);
			} catch (e) {
				throw ConnectError.from(e, Code.Internal);
			}
		}
	};
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol/universal.js
/**
* Assert that the given UniversalServerRequest has a byte stream body, not
* a JSON value.
*
* We accept a JSON object or a byte stream in server requests.
* In practice, only Connect unary handlers will receive a parse
* JSON object. Other call-sites can use this assertion to narrow
* the union type. A failure in such a call-sites indicates that
* the contract between a server framework and the connect-node \
* handler is broken.
*
* @private Internal code, does not follow semantic versioning.
*/
function assertByteStreamRequest(req) {
	if (typeof req.body == "object" && req.body !== null && Symbol.asyncIterator in req.body) return;
	throw new Error("byte stream required, but received JSON");
}
/**
* HTTP 200 OK
*
* @private Internal code, does not follow semantic versioning.
*/
var uResponseOk = { status: 200 };
/**
* HTTP 415 Unsupported Media Type
*
* @private Internal code, does not follow semantic versioning.
*/
var uResponseUnsupportedMediaType = { status: 415 };
/**
* HTTP 405 Method Not Allowed
*
* @private Internal code, does not follow semantic versioning.
*/
var uResponseMethodNotAllowed = { status: 405 };
/**
* HTTP 505 Version Not Supported
*
* @private Internal code, does not follow semantic versioning.
*/
var uResponseVersionNotSupported = { status: 505 };
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol/universal-handler.js
/**
* Asserts that the options are within sane limits, and returns default values
* where no value is provided.
*
* Note that this function does not set default values for `acceptCompression`.
*
* @private Internal code, does not follow semantic versioning.
*/
function validateUniversalHandlerOptions(opt) {
	var _a, _b, _c;
	opt !== null && opt !== void 0 || (opt = {});
	const acceptCompression = opt.acceptCompression ? [...opt.acceptCompression] : [];
	const requireConnectProtocolHeader = (_a = opt.requireConnectProtocolHeader) !== null && _a !== void 0 ? _a : false;
	const maxTimeoutMs = (_b = opt.maxTimeoutMs) !== null && _b !== void 0 ? _b : Number.MAX_SAFE_INTEGER;
	return Object.assign(Object.assign({ acceptCompression }, validateReadWriteMaxBytes(opt.readMaxBytes, opt.writeMaxBytes, opt.compressMinBytes)), {
		jsonOptions: opt.jsonOptions,
		binaryOptions: opt.binaryOptions,
		maxTimeoutMs,
		shutdownSignal: opt.shutdownSignal,
		requireConnectProtocolHeader,
		interceptors: (_c = opt.interceptors) !== null && _c !== void 0 ? _c : [],
		requestGate: opt.requestGate
	});
}
/**
* For the given service implementation, return a universal handler for each
* RPC. The handler serves the given protocols.
*
* At least one protocol is required.
*
* @private Internal code, does not follow semantic versioning.
*/
function createUniversalServiceHandlers(spec, protocols) {
	return Object.entries(spec.methods).map(([, implSpec]) => createUniversalMethodHandler(implSpec, protocols));
}
/**
* Return a universal handler for the given RPC implementation.
* The handler serves the given protocols.
*
* At least one protocol is required.
*
* @private Internal code, does not follow semantic versioning.
*/
function createUniversalMethodHandler(spec, protocols) {
	return negotiateProtocol(protocols.map((f) => f(spec)));
}
/**
* Create a universal handler that negotiates the protocol.
*
* This functions takes one or more handlers - all for the same RPC, but for
* different protocols - and returns a single handler that looks at the
* Content-Type header and the HTTP verb of the incoming request to select
* the appropriate protocol-specific handler.
*
* Raises an error if no protocol handlers were provided, or if they do not
* handle exactly the same RPC.
*
* @private Internal code, does not follow semantic versioning.
*/
function negotiateProtocol(protocolHandlers) {
	if (protocolHandlers.length == 0) throw new ConnectError("at least one protocol is required", Code.Internal);
	const service = protocolHandlers[0].service;
	const method = protocolHandlers[0].method;
	const requestPath = protocolHandlers[0].requestPath;
	if (protocolHandlers.some((h) => h.service !== service || h.method !== method)) throw new ConnectError("cannot negotiate protocol for different RPCs", Code.Internal);
	if (protocolHandlers.some((h) => h.requestPath !== requestPath)) throw new ConnectError("cannot negotiate protocol for different requestPaths", Code.Internal);
	async function protocolNegotiatingHandler(request) {
		var _a;
		if (method.methodKind == "bidi_streaming" && request.httpVersion.startsWith("1.")) return Object.assign(Object.assign({}, uResponseVersionNotSupported), { header: new Headers({ Connection: "close" }) });
		const contentType = (_a = request.header.get("Content-Type")) !== null && _a !== void 0 ? _a : "";
		const matchingMethod = protocolHandlers.filter((h) => h.allowedMethods.includes(request.method));
		if (matchingMethod.length == 0) return uResponseMethodNotAllowed;
		if (matchingMethod.length == 1 && contentType === "") {
			const onlyMatch = matchingMethod[0];
			return onlyMatch(request);
		}
		const matchingContentTypes = matchingMethod.filter((h) => h.supportedContentType(contentType));
		if (matchingContentTypes.length == 0) return uResponseUnsupportedMediaType;
		const firstMatch = matchingContentTypes[0];
		return firstMatch(request);
	}
	return Object.assign(protocolNegotiatingHandler, {
		service,
		method,
		requestPath,
		supportedContentType: contentTypeMatcher(...protocolHandlers.map((h) => h.supportedContentType)),
		protocolNames: protocolHandlers.flatMap((h) => h.protocolNames).filter((value, index, array) => array.indexOf(value) === index),
		allowedMethods: protocolHandlers.flatMap((h) => h.allowedMethods).filter((value, index, array) => array.indexOf(value) === index)
	});
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-grpc-web/handler-factory.js
var protocolName$2 = "grpc-web";
var methodPost$2 = "POST";
/**
* Create a factory that creates gRPC-web handlers.
*/
function createHandlerFactory$2(options) {
	const opt = validateUniversalHandlerOptions(options);
	const trailerSerialization = createTrailerSerialization();
	function fact(spec) {
		const h = createHandler$1(opt, trailerSerialization, spec);
		return Object.assign(h, {
			protocolNames: [protocolName$2],
			allowedMethods: [methodPost$2],
			supportedContentType: contentTypeMatcher(contentTypeRegExp$2),
			requestPath: createMethodUrl("/", spec.method),
			service: spec.method.parent,
			method: spec.method
		});
	}
	fact.protocolName = protocolName$2;
	return fact;
}
function createHandler$1(opt, trailerSerialization, spec) {
	const serialization = createMethodSerializationLookup(spec.method, opt.binaryOptions, opt.jsonOptions, opt);
	return async function handle(req) {
		assertByteStreamRequest(req);
		const type = parseContentType$2(req.header.get(headerContentType$1));
		if (type == void 0 || type.text) return uResponseUnsupportedMediaType;
		if (req.method !== methodPost$2) return uResponseMethodNotAllowed;
		const timeout = parseTimeout$1(req.header.get(headerTimeout$1), opt.maxTimeoutMs);
		const context = createHandlerContext(Object.assign(Object.assign({}, spec), {
			service: spec.method.parent,
			requestMethod: req.method,
			protocolName: protocolName$2,
			timeoutMs: timeout.timeoutMs,
			shutdownSignal: opt.shutdownSignal,
			requestSignal: req.signal,
			requestHeader: req.header,
			url: req.url,
			responseHeader: { [headerContentType$1]: type.binary ? contentTypeProto$1 : contentTypeJson$1 },
			responseTrailer: { [headerGrpcStatus]: "0" },
			contextValues: req.contextValues
		}));
		const compression = compressionNegotiate(opt.acceptCompression, req.header.get(headerEncoding), req.header.get(headerAcceptEncoding), headerAcceptEncoding);
		if (compression.response) context.responseHeader.set(headerEncoding, compression.response.name);
		const inputIt = pipe(req.body, transformPrepend(() => {
			if (compression.error) throw compression.error;
			if (timeout.error) throw timeout.error;
		}), transformSplitEnvelope(opt.readMaxBytes), transformDecompressEnvelope(compression.request, opt.readMaxBytes), transformParseEnvelope(serialization.getI(type.binary), 128));
		const it = await applyRequestGate(context, opt.requestGate, () => transformInvokeImplementation(spec, context, opt.interceptors)(inputIt));
		const outputIt = pipe({ [Symbol.asyncIterator]() {
			return {
				next: () => it.next(),
				throw: (e) => {
					var _a, _b;
					context.abort(e);
					return (_b = (_a = it.throw) === null || _a === void 0 ? void 0 : _a.call(it, e)) !== null && _b !== void 0 ? _b : Promise.reject({ done: true });
				},
				return: (v) => {
					var _a, _b;
					context.abort();
					return (_b = (_a = it.return) === null || _a === void 0 ? void 0 : _a.call(it, v)) !== null && _b !== void 0 ? _b : Promise.resolve({
						done: true,
						value: v
					});
				}
			};
		} }, transformSerializeEnvelope(serialization.getO(type.binary)), transformCatchFinally((e) => {
			context.abort(e);
			if (e instanceof ConnectError) setTrailerStatus(context.responseTrailer, e);
			else if (e !== void 0) setTrailerStatus(context.responseTrailer, new ConnectError("internal error", Code.Internal, void 0, void 0, e));
			return {
				flags: 128,
				data: trailerSerialization.serialize(context.responseTrailer)
			};
		}), transformCompressEnvelope(compression.response, opt.compressMinBytes), transformJoinEnvelopes(), { propagateDownStreamError: true });
		return Object.assign(Object.assign({}, uResponseOk), {
			body: await untilFirst(outputIt),
			header: context.responseHeader
		});
	};
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-grpc/content-type.js
/**
* Regular Expression that matches any valid gRPC Content-Type header value.
*
* @private Internal code, does not follow semantic versioning.
*/
var contentTypeRegExp$1 = /^application\/grpc(?:\+(?:(json)(?:; ?charset=utf-?8)?|proto))?$/i;
var contentTypeProto = "application/grpc+proto";
var contentTypeJson = "application/grpc+json";
/**
* Parse a gRPC Content-Type header.
*
* @private Internal code, does not follow semantic versioning.
*/
function parseContentType$1(contentType) {
	const match = contentType === null || contentType === void 0 ? void 0 : contentType.match(contentTypeRegExp$1);
	if (!match) return;
	return { binary: !match[1] };
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-grpc/handler-factory.js
var protocolName$1 = "grpc";
var methodPost$1 = "POST";
/**
* Create a factory that creates gRPC handlers.
*/
function createHandlerFactory$1(options) {
	const opt = validateUniversalHandlerOptions(options);
	function fact(spec) {
		const h = createHandler(opt, spec);
		return Object.assign(h, {
			protocolNames: [protocolName$1],
			allowedMethods: [methodPost$1],
			supportedContentType: contentTypeMatcher(contentTypeRegExp$1),
			requestPath: createMethodUrl("/", spec.method),
			service: spec.method.parent,
			method: spec.method
		});
	}
	fact.protocolName = protocolName$1;
	return fact;
}
function createHandler(opt, spec) {
	const serialization = createMethodSerializationLookup(spec.method, opt.binaryOptions, opt.jsonOptions, opt);
	return async function handle(req) {
		assertByteStreamRequest(req);
		const type = parseContentType$1(req.header.get(headerContentType$1));
		if (type == void 0) return uResponseUnsupportedMediaType;
		if (req.method !== methodPost$1) return uResponseMethodNotAllowed;
		const timeout = parseTimeout$1(req.header.get(headerTimeout$1), opt.maxTimeoutMs);
		const context = createHandlerContext(Object.assign(Object.assign({}, spec), {
			service: spec.method.parent,
			requestMethod: req.method,
			protocolName: protocolName$1,
			timeoutMs: timeout.timeoutMs,
			shutdownSignal: opt.shutdownSignal,
			requestSignal: req.signal,
			requestHeader: req.header,
			url: req.url,
			responseHeader: { [headerContentType$1]: type.binary ? contentTypeProto : contentTypeJson },
			responseTrailer: { [headerGrpcStatus]: "0" },
			contextValues: req.contextValues
		}));
		const compression = compressionNegotiate(opt.acceptCompression, req.header.get(headerEncoding), req.header.get(headerAcceptEncoding), headerAcceptEncoding);
		if (compression.response) context.responseHeader.set(headerEncoding, compression.response.name);
		const inputIt = pipe(req.body, transformPrepend(() => {
			if (compression.error) throw compression.error;
			if (timeout.error) throw timeout.error;
		}), transformSplitEnvelope(opt.readMaxBytes), transformDecompressEnvelope(compression.request, opt.readMaxBytes), transformParseEnvelope(serialization.getI(type.binary)));
		const it = await applyRequestGate(context, opt.requestGate, () => transformInvokeImplementation(spec, context, opt.interceptors)(inputIt));
		const outputIt = pipe({ [Symbol.asyncIterator]() {
			return {
				next: () => it.next(),
				throw: (e) => {
					var _a, _b;
					context.abort(e);
					return (_b = (_a = it.throw) === null || _a === void 0 ? void 0 : _a.call(it, e)) !== null && _b !== void 0 ? _b : Promise.reject({ done: true });
				},
				return: (v) => {
					var _a, _b;
					context.abort();
					return (_b = (_a = it.return) === null || _a === void 0 ? void 0 : _a.call(it, v)) !== null && _b !== void 0 ? _b : Promise.resolve({
						done: true,
						value: v
					});
				}
			};
		} }, transformSerializeEnvelope(serialization.getO(type.binary)), transformCompressEnvelope(compression.response, opt.compressMinBytes), transformJoinEnvelopes(), transformCatchFinally((e) => {
			context.abort(e);
			if (e instanceof ConnectError) setTrailerStatus(context.responseTrailer, e);
			else if (e !== void 0) setTrailerStatus(context.responseTrailer, new ConnectError("internal error", Code.Internal, void 0, void 0, e));
		}), { propagateDownStreamError: true });
		return Object.assign(Object.assign({}, uResponseOk), {
			body: await untilFirst(outputIt),
			header: context.responseHeader,
			trailer: context.responseTrailer
		});
	};
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-connect/content-type.js
/**
* Regular Expression that matches any valid Connect Content-Type header value.
*
* @private Internal code, does not follow semantic versioning.
*/
var contentTypeRegExp = /^application\/(connect\+)?(?:(json)(?:; ?charset=utf-?8)?|(proto))$/i;
/**
* Regular Expression that matches a Connect unary Content-Type header value.
*
* @private Internal code, does not follow semantic versioning.
*/
var contentTypeUnaryRegExp = /^application\/(?:json(?:; ?charset=utf-?8)?|proto)$/i;
/**
* Regular Expression that matches a Connect streaming Content-Type header value.
*
* @private Internal code, does not follow semantic versioning.
*/
var contentTypeStreamRegExp = /^application\/connect\+?(?:json(?:; ?charset=utf-?8)?|proto)$/i;
var contentTypeUnaryProto = "application/proto";
var contentTypeUnaryJson = "application/json";
var contentTypeStreamProto = "application/connect+proto";
var contentTypeStreamJson = "application/connect+json";
var encodingProto = "proto";
var encodingJson = "json";
/**
* Parse a Connect Content-Type header.
*
* @private Internal code, does not follow semantic versioning.
*/
function parseContentType(contentType) {
	const match = contentType === null || contentType === void 0 ? void 0 : contentType.match(contentTypeRegExp);
	if (!match) return;
	return {
		stream: !!match[1],
		binary: !!match[3]
	};
}
/**
* Parse a Connect Get encoding query parameter.
*
* @private Internal code, does not follow semantic versioning.
*/
function parseEncodingQuery(encoding) {
	switch (encoding) {
		case encodingProto: return {
			stream: false,
			binary: true
		};
		case encodingJson: return {
			stream: false,
			binary: false
		};
		default: return;
	}
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-connect/error-json.js
var __rest = function(s, e) {
	var t = {};
	for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0) t[p] = s[p];
	if (s != null && typeof Object.getOwnPropertySymbols === "function") {
		for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i])) t[p[i]] = s[p[i]];
	}
	return t;
};
/**
* Parse a Connect error from a JSON value.
* Will return a ConnectError, and throw the provided fallback if parsing failed.
*
* @private Internal code, does not follow semantic versioning.
*/
function errorFromJson(jsonValue, metadata, fallback) {
	var _a;
	if (metadata) new Headers(metadata).forEach((value, key) => fallback.metadata.append(key, value));
	if (typeof jsonValue !== "object" || jsonValue == null || Array.isArray(jsonValue)) throw fallback;
	let code = fallback.code;
	if ("code" in jsonValue && typeof jsonValue.code === "string") code = (_a = codeFromString(jsonValue.code)) !== null && _a !== void 0 ? _a : code;
	const message = jsonValue.message;
	if (message != null && typeof message !== "string") throw fallback;
	const error = new ConnectError(message !== null && message !== void 0 ? message : "", code, metadata);
	error.isWireError = true;
	if ("details" in jsonValue && Array.isArray(jsonValue.details)) for (const detail of jsonValue.details) {
		if (detail === null || typeof detail != "object" || Array.isArray(detail) || typeof detail.type != "string" || typeof detail.value != "string") throw fallback;
		try {
			error.details.push({
				type: detail.type,
				value: base64Decode(detail.value),
				debug: detail.debug
			});
		} catch (e) {
			throw fallback;
		}
	}
	return error;
}
/**
* Parse a Connect error from a serialized JSON value.
* Will return a ConnectError, and throw the provided fallback if parsing failed.
*
* @private Internal code, does not follow semantic versioning.
*/
function errorFromJsonBytes(bytes, metadata, fallback) {
	let jsonValue;
	try {
		jsonValue = JSON.parse(new TextDecoder().decode(bytes));
	} catch (e) {
		throw fallback;
	}
	return errorFromJson(jsonValue, metadata, fallback);
}
/**
* Serialize the given error to JSON.
*
* The JSON serialization options are required to produce the optional
* human-readable representation in the "debug" key if the detail uses
* google.protobuf.Any. If serialization of the "debug" value fails, it
* is silently disregarded.
*
* See https://connectrpc.com/docs/protocol#error-end-stream
*
* @private Internal code, does not follow semantic versioning.
*/
function errorToJson(error, jsonWriteOptions) {
	const o = { code: codeToString(error.code) };
	if (error.rawMessage.length > 0) o.message = error.rawMessage;
	if (error.details.length > 0) o.details = error.details.map((detail) => {
		if ("desc" in detail) {
			const msg = create(detail.desc, detail.value);
			const i = {
				type: detail.desc.typeName,
				value: toBinary(detail.desc, msg)
			};
			try {
				i.debug = toJson(detail.desc, msg, jsonWriteOptions);
			} catch (e) {}
			return i;
		}
		return detail;
	}).map((_a) => {
		var { value } = _a, rest = __rest(_a, ["value"]);
		return Object.assign(Object.assign({}, rest), { value: base64Encode(value, "std_raw") });
	});
	return o;
}
/**
* Serialize the given error to JSON. This calls errorToJson(), but stringifies
* the result, and converts it into a UInt8Array.
*
* @private Internal code, does not follow semantic versioning.
*/
function errorToJsonBytes(error, jsonWriteOptions) {
	const textEncoder = new TextEncoder();
	try {
		const jsonObject = errorToJson(error, jsonWriteOptions);
		const jsonString = JSON.stringify(jsonObject);
		return textEncoder.encode(jsonString);
	} catch (e) {
		throw new ConnectError(`failed to serialize Connect Error: ${e instanceof Error ? e.message : String(e)}`, Code.Internal);
	}
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-connect/end-stream.js
/**
* Parse an EndStreamResponse of the Connect protocol.
* Throws a ConnectError on malformed input.
*
* @private Internal code, does not follow semantic versioning.
*/
function endStreamFromJson(data) {
	const parseErr = new ConnectError("invalid end stream", Code.Unknown);
	let jsonValue;
	try {
		jsonValue = JSON.parse(typeof data == "string" ? data : new TextDecoder().decode(data));
	} catch (e) {
		throw parseErr;
	}
	if (typeof jsonValue != "object" || jsonValue == null || Array.isArray(jsonValue)) throw parseErr;
	const metadata = new Headers();
	if ("metadata" in jsonValue) {
		if (typeof jsonValue.metadata != "object" || jsonValue.metadata == null || Array.isArray(jsonValue.metadata)) throw parseErr;
		for (const [key, values] of Object.entries(jsonValue.metadata)) {
			if (!Array.isArray(values) || values.some((value) => typeof value != "string")) throw parseErr;
			for (const value of values) metadata.append(key, value);
		}
	}
	return {
		metadata,
		error: "error" in jsonValue && jsonValue.error != null ? errorFromJson(jsonValue.error, metadata, parseErr) : void 0
	};
}
/**
* Serialize the given EndStreamResponse to JSON.
*
* The JSON serialization options are required to produce the optional
* human-readable representation of error details if the detail uses
* google.protobuf.Any.
*
* See https://connectrpc.com/docs/protocol#error-end-stream
*
* @private Internal code, does not follow semantic versioning.
*/
function endStreamToJson(metadata, error, jsonWriteOptions) {
	const es = {};
	if (error !== void 0) {
		es.error = errorToJson(error, jsonWriteOptions);
		if (!error.isWireError) mergeNonProtocolHeaders(metadata, error.metadata);
	}
	let hasMetadata = false;
	const md = {};
	metadata.forEach((value, key) => {
		hasMetadata = true;
		md[key] = [value];
	});
	if (hasMetadata) es.metadata = md;
	return es;
}
/**
* Create a Serialization object that serializes a Connect EndStreamResponse.
*
* @private Internal code, does not follow semantic versioning.
*/
function createEndStreamSerialization(options) {
	const textEncoder = new TextEncoder();
	return {
		serialize(data) {
			try {
				const jsonObject = endStreamToJson(data.metadata, data.error, options);
				const jsonString = JSON.stringify(jsonObject);
				return textEncoder.encode(jsonString);
			} catch (e) {
				throw new ConnectError(`failed to serialize EndStreamResponse: ${e instanceof Error ? e.message : String(e)}`, Code.Internal);
			}
		},
		parse(data) {
			try {
				return endStreamFromJson(data);
			} catch (e) {
				throw new ConnectError(`failed to parse EndStreamResponse: ${e instanceof Error ? e.message : String(e)}`, Code.InvalidArgument);
			}
		}
	};
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-connect/http-status.js
/**
* Determine the Connect error code for the given HTTP status code.
* See https://connectrpc.com/docs/protocol/#http-to-error-code
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
/**
* Returns a HTTP status code for the given Connect code.
* See https://connectrpc.com/docs/protocol#error-codes
*
* @private Internal code, does not follow semantic versioning.
*/
function codeToHttpStatus(code) {
	switch (code) {
		case Code.Canceled: return 499;
		case Code.Unknown: return 500;
		case Code.InvalidArgument: return 400;
		case Code.DeadlineExceeded: return 504;
		case Code.NotFound: return 404;
		case Code.AlreadyExists: return 409;
		case Code.PermissionDenied: return 403;
		case Code.ResourceExhausted: return 429;
		case Code.FailedPrecondition: return 400;
		case Code.Aborted: return 409;
		case Code.OutOfRange: return 400;
		case Code.Unimplemented: return 501;
		case Code.Internal: return 500;
		case Code.Unavailable: return 503;
		case Code.DataLoss: return 500;
		case Code.Unauthenticated: return 401;
		default: return 500;
	}
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-connect/parse-timeout.js
/**
* Parse a Connect Timeout (Deadline) header.
*
* @private Internal code, does not follow semantic versioning.
*/
function parseTimeout(value, maxTimeoutMs) {
	if (value === null) return {};
	const results = /^\d{1,10}$/.exec(value);
	if (results === null) return { error: new ConnectError(`protocol error: invalid connect timeout value: ${value}`, Code.InvalidArgument) };
	const timeoutMs = parseInt(results[0]);
	if (timeoutMs > maxTimeoutMs) return {
		timeoutMs,
		error: new ConnectError(`timeout ${timeoutMs}ms must be <= ${maxTimeoutMs}`, Code.InvalidArgument)
	};
	return { timeoutMs: parseInt(results[0]) };
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-connect/query-params.js
/**
* @private Internal code, does not follow semantic versioning.
*/
var paramConnectVersion = "connect";
var paramEncoding = "encoding";
var paramCompression = "compression";
var paramBase64 = "base64";
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-connect/trailer-mux.js
/**
* In unary RPCs, Connect transports trailing metadata as response header
* fields, prefixed with "trailer-".
*
* This function demuxes headers and trailers into two separate Headers
* objects.
*
* @private Internal code, does not follow semantic versioning.
*/
function trailerDemux(header) {
	const h = new Headers(), t = new Headers();
	header.forEach((value, key) => {
		if (key.toLowerCase().startsWith("trailer-")) t.append(key.substring(8), value);
		else h.append(key, value);
	});
	return [h, t];
}
/**
* In unary RPCs, Connect transports trailing metadata as response header
* fields, prefixed with "trailer-".
*
* This function muxes a header and a trailer into a single Headers object.
*
* @private Internal code, does not follow semantic versioning.
*/
function trailerMux(header, trailer) {
	const h = new Headers(header);
	trailer.forEach((value, key) => {
		h.append(`trailer-${key}`, value);
	});
	return h;
}
/**
* Requires the Connect-Protocol-Version header to be present with the expected
* value. Raises a ConnectError with Code.InvalidArgument otherwise.
*
* @private Internal code, does not follow semantic versioning.
*/
function requireProtocolVersionHeader(requestHeader) {
	const v = requestHeader.get(headerProtocolVersion);
	if (v === null) throw new ConnectError(`missing required header: set ${headerProtocolVersion} to "1"`, Code.InvalidArgument);
	if (v !== "1") throw new ConnectError(`${headerProtocolVersion} must be "1": got "${v}"`, Code.InvalidArgument);
}
/**
* Requires the connect query parameter to be present with the expected value.
* Raises a ConnectError with Code.InvalidArgument otherwise.
*
* @private Internal code, does not follow semantic versioning.
*/
function requireProtocolVersionParam(queryParams) {
	const v = queryParams.get(paramConnectVersion);
	if (v === null) throw new ConnectError(`missing required parameter: set ${paramConnectVersion} to "v1"`, Code.InvalidArgument);
	if (v !== `v1`) throw new ConnectError(`${paramConnectVersion} must be "v1": got "${v}"`, Code.InvalidArgument);
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-connect/handler-factory.js
var protocolName = "connect";
var methodPost = "POST";
var methodGet = "GET";
/**
* Create a factory that creates Connect handlers.
*/
function createHandlerFactory(options) {
	const opt = validateUniversalHandlerOptions(options);
	const endStreamSerialization = createEndStreamSerialization(opt.jsonOptions);
	function fact(spec) {
		let h;
		let contentTypeRegExp;
		const serialization = createMethodSerializationLookup(spec.method, opt.binaryOptions, opt.jsonOptions, opt);
		switch (spec.kind) {
			case "unary":
				contentTypeRegExp = contentTypeUnaryRegExp;
				h = createUnaryHandler(opt, spec, serialization);
				break;
			default:
				contentTypeRegExp = contentTypeStreamRegExp;
				h = createStreamHandler(opt, spec, serialization, endStreamSerialization);
		}
		const allowedMethods = [methodPost];
		if (spec.method.idempotency === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS) allowedMethods.push(methodGet);
		return Object.assign(h, {
			protocolNames: [protocolName],
			supportedContentType: contentTypeMatcher(contentTypeRegExp),
			allowedMethods,
			requestPath: createMethodUrl("/", spec.method),
			service: spec.method.parent,
			method: spec.method
		});
	}
	fact.protocolName = protocolName;
	return fact;
}
function createUnaryHandler(opt, spec, serialization) {
	return async function handle(req) {
		const isGet = req.method == methodGet;
		if (isGet && spec.method.idempotency != MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS) return uResponseMethodNotAllowed;
		const queryParams = new URL(req.url).searchParams;
		const compressionRequested = isGet ? queryParams.get(paramCompression) : req.header.get(headerUnaryEncoding);
		const type = isGet ? parseEncodingQuery(queryParams.get(paramEncoding)) : parseContentType(req.header.get(headerContentType));
		if (type == void 0 || type.stream) return uResponseUnsupportedMediaType;
		const timeout = parseTimeout(req.header.get(headerTimeout), opt.maxTimeoutMs);
		const context = createHandlerContext(Object.assign(Object.assign({}, spec), {
			service: spec.method.parent,
			requestMethod: req.method,
			protocolName,
			timeoutMs: timeout.timeoutMs,
			shutdownSignal: opt.shutdownSignal,
			requestSignal: req.signal,
			requestHeader: req.header,
			url: req.url,
			responseHeader: { [headerContentType]: type.binary ? contentTypeUnaryProto : contentTypeUnaryJson },
			contextValues: req.contextValues
		}));
		const compression = compressionNegotiate(opt.acceptCompression, compressionRequested, req.header.get(headerUnaryAcceptEncoding), headerUnaryAcceptEncoding);
		let status = uResponseOk.status;
		let body;
		try {
			if (opt.requestGate !== void 0) await opt.requestGate(context);
			if (opt.requireConnectProtocolHeader) {
				if (isGet) requireProtocolVersionParam(queryParams);
				else requireProtocolVersionHeader(req.header);
			}
			if (compression.error) throw compression.error;
			if (timeout.error) throw timeout.error;
			let reqBody;
			if (isGet) reqBody = await readUnaryMessageFromQuery(opt.readMaxBytes, compression.request, queryParams);
			else reqBody = await readUnaryMessageFromBody(opt.readMaxBytes, compression.request, req);
			const output = await invokeUnaryImplementation(spec, context, parseUnaryMessage(spec.method, type.binary, serialization, reqBody), opt.interceptors);
			body = serialization.getO(type.binary).serialize(output);
		} catch (e) {
			context.abort(e);
			let error;
			if (e instanceof ConnectError) error = e;
			else error = new ConnectError("internal error", Code.Internal, void 0, void 0, e);
			status = codeToHttpStatus(error.code);
			context.responseHeader.set(headerContentType, contentTypeUnaryJson);
			if (!error.isWireError) mergeNonProtocolHeaders(context.responseHeader, error.metadata);
			body = errorToJsonBytes(error, opt.jsonOptions);
		} finally {
			context.abort();
		}
		if (compression.response && body.byteLength >= opt.compressMinBytes) {
			body = await compression.response.compress(body);
			context.responseHeader.set(headerUnaryEncoding, compression.response.name);
		}
		const header = trailerMux(context.responseHeader, context.responseTrailer);
		header.set(headerUnaryContentLength, body.byteLength.toString(10));
		return {
			status,
			body: createAsyncIterable([body]),
			header
		};
	};
}
async function readUnaryMessageFromBody(readMaxBytes, compression, request) {
	if (typeof request.body == "object" && request.body !== null && Symbol.asyncIterator in request.body) {
		let reqBytes = await readAllBytes(request.body, readMaxBytes, request.header.get(headerUnaryContentLength));
		if (compression) reqBytes = await compression.decompress(reqBytes, readMaxBytes);
		return reqBytes;
	}
	return request.body;
}
async function readUnaryMessageFromQuery(readMaxBytes, compression, queryParams) {
	var _a;
	const base64 = queryParams.get(paramBase64);
	const message = (_a = queryParams.get("message")) !== null && _a !== void 0 ? _a : "";
	let decoded;
	if (base64 === "1") decoded = base64Decode(message);
	else decoded = new TextEncoder().encode(message);
	if (compression) decoded = await compression.decompress(decoded, readMaxBytes);
	return decoded;
}
function parseUnaryMessage(method, useBinaryFormat, serialization, input) {
	if (input instanceof Uint8Array) return serialization.getI(useBinaryFormat).parse(input);
	if (useBinaryFormat) throw new ConnectError("received parsed JSON request body, but content-type indicates binary format", Code.Internal);
	try {
		return fromJson(method.input, input);
	} catch (e) {
		throw ConnectError.from(e, Code.InvalidArgument);
	}
}
function createStreamHandler(opt, spec, serialization, endStreamSerialization) {
	return async function handle(req) {
		assertByteStreamRequest(req);
		const type = parseContentType(req.header.get(headerContentType));
		if (type == void 0 || !type.stream) return uResponseUnsupportedMediaType;
		if (req.method !== methodPost) return uResponseMethodNotAllowed;
		const timeout = parseTimeout(req.header.get(headerTimeout), opt.maxTimeoutMs);
		const context = createHandlerContext(Object.assign(Object.assign({}, spec), {
			service: spec.method.parent,
			requestMethod: req.method,
			protocolName,
			timeoutMs: timeout.timeoutMs,
			shutdownSignal: opt.shutdownSignal,
			requestSignal: req.signal,
			requestHeader: req.header,
			url: req.url,
			responseHeader: { [headerContentType]: type.binary ? contentTypeStreamProto : contentTypeStreamJson },
			contextValues: req.contextValues
		}));
		const compression = compressionNegotiate(opt.acceptCompression, req.header.get(headerStreamEncoding), req.header.get(headerStreamAcceptEncoding), headerStreamAcceptEncoding);
		if (compression.response) context.responseHeader.set(headerStreamEncoding, compression.response.name);
		const inputIt = pipe(req.body, transformPrepend(() => {
			if (opt.requireConnectProtocolHeader) requireProtocolVersionHeader(req.header);
			if (compression.error) throw compression.error;
			if (timeout.error) throw timeout.error;
		}), transformSplitEnvelope(opt.readMaxBytes), transformDecompressEnvelope(compression.request, opt.readMaxBytes), transformParseEnvelope(serialization.getI(type.binary), 2));
		const it = await applyRequestGate(context, opt.requestGate, () => transformInvokeImplementation(spec, context, opt.interceptors)(inputIt));
		const outputIt = pipe({ [Symbol.asyncIterator]() {
			return {
				next: () => it.next(),
				throw: (e) => {
					var _a, _b;
					context.abort(e);
					return (_b = (_a = it.throw) === null || _a === void 0 ? void 0 : _a.call(it, e)) !== null && _b !== void 0 ? _b : Promise.reject({ done: true });
				},
				return: (v) => {
					var _a, _b;
					context.abort();
					return (_b = (_a = it.return) === null || _a === void 0 ? void 0 : _a.call(it, v)) !== null && _b !== void 0 ? _b : Promise.resolve({
						done: true,
						value: v
					});
				}
			};
		} }, transformSerializeEnvelope(serialization.getO(type.binary)), transformCatchFinally((e) => {
			context.abort(e);
			const end = { metadata: context.responseTrailer };
			if (e instanceof ConnectError) end.error = e;
			else if (e !== void 0) end.error = new ConnectError("internal error", Code.Internal, void 0, void 0, e);
			return {
				flags: 2,
				data: endStreamSerialization.serialize(end)
			};
		}), transformCompressEnvelope(compression.response, opt.compressMinBytes), transformJoinEnvelopes(), { propagateDownStreamError: true });
		return Object.assign(Object.assign({}, uResponseOk), {
			body: await untilFirst(outputIt),
			header: context.responseHeader
		});
	};
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/router.js
/**
* Create a new ConnectRouter.
*/
function createConnectRouter(routerOptions) {
	const base = whichProtocols(routerOptions);
	const handlers = [];
	const router = {
		handlers,
		service: (service, implementation, options) => {
			const { protocols } = whichProtocols(options, base);
			handlers.push(...createUniversalServiceHandlers(createServiceImplSpec(service, implementation), protocols));
			return router;
		},
		rpc: (method, impl, opt) => {
			const { protocols } = whichProtocols(opt, base);
			handlers.push(createUniversalMethodHandler(createMethodImplSpec(method, impl), protocols));
			return router;
		}
	};
	return router;
}
function whichProtocols(options, base) {
	if (base && !options) return base;
	const opt = base ? Object.assign(Object.assign({}, validateUniversalHandlerOptions(base.options)), options) : Object.assign(Object.assign({}, options), validateUniversalHandlerOptions(options !== null && options !== void 0 ? options : {}));
	const protocols = [];
	if ((options === null || options === void 0 ? void 0 : options.grpc) !== false) protocols.push(createHandlerFactory$1(opt));
	if ((options === null || options === void 0 ? void 0 : options.grpcWeb) !== false) protocols.push(createHandlerFactory$2(opt));
	if ((options === null || options === void 0 ? void 0 : options.connect) !== false) protocols.push(createHandlerFactory(opt));
	if (protocols.length === 0) throw new ConnectError("cannot create handler, all protocols are disabled", Code.InvalidArgument);
	return {
		options: opt,
		protocols
	};
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/cors.js
/**
* CORS prevents rogue scripts in a web browser from making arbitrary requests
* to other web servers.
*
* This object provides helpful constants to configure CORS middleware for
* cross-domain requests with the protocols supported by Connect.
*
* Make sure to add application-specific headers that your application
* uses as well.
*/
var cors = {
	/**
	* Request methods that scripts running in the browser are permitted to use.
	*
	* To support cross-domain requests with the protocols supported by Connect,
	* these headers fields must be included in the preflight response header
	* Access-Control-Allow-Methods.
	*/
	allowedMethods: ["POST", "GET"],
	/**
	* Header fields that scripts running in the browser are permitted to send.
	*
	* To support cross-domain requests with the protocols supported by Connect,
	* these field names must be included in the preflight response header
	* Access-Control-Allow-Headers.
	*
	* Make sure to include any application-specific headers your browser client
	* may send.
	*/
	allowedHeaders: [
		headerContentType,
		headerProtocolVersion,
		headerTimeout,
		headerStreamEncoding,
		headerStreamAcceptEncoding,
		headerUnaryEncoding,
		headerUnaryAcceptEncoding,
		headerMessageType,
		headerXGrpcWeb,
		headerXUserAgent,
		headerTimeout$1
	],
	/**
	* Header fields that scripts running the browser are permitted to see.
	*
	* To support cross-domain requests with the protocols supported by Connect,
	* these field names must be included in header Access-Control-Expose-Headers
	* of the actual response.
	*
	* Make sure to include any application-specific headers your browser client
	* should see. If your application uses trailers, they will be sent as header
	* fields with a `Trailer-` prefix for Connect unary RPCs - make sure to
	* expose them as well if you want them to be visible in all supported
	* protocols.
	*/
	exposedHeaders: [
		headerGrpcStatus,
		headerGrpcMessage,
		headerStatusDetailsBin,
		headerUnaryEncoding,
		headerStreamEncoding
	]
};
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-connect/request-header.js
/**
* Creates headers for a Connect request.
*
* @private Internal code, does not follow semantic versioning.
*/
function requestHeader(methodKind, useBinaryFormat, timeoutMs, userProvidedHeaders, setUserAgent) {
	const result = new Headers(userProvidedHeaders !== null && userProvidedHeaders !== void 0 ? userProvidedHeaders : {});
	if (timeoutMs !== void 0) result.set(headerTimeout, `${timeoutMs}`);
	result.set(headerContentType, methodKind == "unary" ? useBinaryFormat ? contentTypeUnaryProto : contentTypeUnaryJson : useBinaryFormat ? contentTypeStreamProto : contentTypeStreamJson);
	result.set(headerProtocolVersion, "1");
	if (!result.has("User-Agent") && setUserAgent) result.set(headerUserAgent, "connect-es/2.2.0");
	return result;
}
/**
* Creates headers for a Connect request with compression.
*
* Note that we always set the Content-Encoding header for unary methods.
* It is up to the caller to decide whether to apply compression - and remove
* the header if compression is not used, for example because the payload is
* too small to make compression effective.
*
* @private Internal code, does not follow semantic versioning.
*/
function requestHeaderWithCompression(methodKind, useBinaryFormat, timeoutMs, userProvidedHeaders, acceptCompression, sendCompression, setUserAgent) {
	const result = requestHeader(methodKind, useBinaryFormat, timeoutMs, userProvidedHeaders, setUserAgent);
	if (sendCompression != null) {
		const name = methodKind == "unary" ? headerUnaryEncoding : headerStreamEncoding;
		result.set(name, sendCompression.name);
	}
	if (acceptCompression.length > 0) {
		const name = methodKind == "unary" ? headerUnaryAcceptEncoding : headerStreamAcceptEncoding;
		result.set(name, acceptCompression.map((c) => c.name).join(","));
	}
	return result;
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-connect/validate-response.js
/**
* Validates response status and header for the Connect protocol.
* Throws a ConnectError if the header indicates an error, or if
* the content type is unexpected, with the following exception:
* For unary RPCs with an HTTP error status, this returns an error
* derived from the HTTP status instead of throwing it, giving an
* implementation a chance to parse a Connect error from the wire.
*
* @private Internal code, does not follow semantic versioning.
*/
function validateResponse(methodKind, useBinaryFormat, status, headers) {
	const mimeType = headers.get(headerContentType);
	const parsedType = parseContentType(mimeType);
	if (status !== 200) {
		const errorFromStatus = new ConnectError(`HTTP ${status}`, codeFromHttpStatus(status), headers);
		if (methodKind == "unary" && parsedType && !parsedType.binary) return {
			isUnaryError: true,
			unaryError: errorFromStatus
		};
		throw errorFromStatus;
	}
	const allowedContentType = {
		binary: useBinaryFormat,
		stream: methodKind !== "unary"
	};
	if ((parsedType === null || parsedType === void 0 ? void 0 : parsedType.binary) !== allowedContentType.binary || parsedType.stream !== allowedContentType.stream) throw new ConnectError(`unsupported content type ${mimeType}`, parsedType === void 0 ? Code.Unknown : Code.Internal, headers);
	return { isUnaryError: false };
}
/**
* Validates response status and header for the Connect protocol.
* This function is identical to validateResponse(), but also verifies
* that a given encoding header is acceptable.
*
* @private
*/
function validateResponseWithCompression(methodKind, acceptCompression, useBinaryFormat, status, headers) {
	let compression;
	const encoding = headers.get(methodKind == "unary" ? headerUnaryEncoding : headerStreamEncoding);
	if (encoding != null && encoding.toLowerCase() !== "identity") {
		compression = acceptCompression.find((c) => c.name === encoding);
		if (!compression) throw new ConnectError(`unsupported response encoding "${encoding}"`, Code.Internal, headers);
	}
	return Object.assign({ compression }, validateResponse(methodKind, useBinaryFormat, status, headers));
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-connect/get-request.js
var contentTypePrefix = "application/";
function encodeMessageForUrl(message, useBase64) {
	if (useBase64) return base64Encode(message, "url");
	return encodeURIComponent(new TextDecoder().decode(message));
}
/**
* @private Internal code, does not follow semantic versioning.
*/
function transformConnectPostToGetRequest(request, message, useBase64) {
	let query = `?connect=v1`;
	let compressionQuery = "";
	const compression = request.header.get(headerUnaryEncoding);
	if (compression !== null && compression !== "identity") {
		compressionQuery = "&compression=" + encodeURIComponent(compression);
		useBase64 = true;
	}
	if (useBase64) query += "&base64=1";
	query += compressionQuery;
	const contentType = request.header.get(headerContentType);
	if ((contentType === null || contentType === void 0 ? void 0 : contentType.indexOf(contentTypePrefix)) === 0) query += "&encoding=" + encodeURIComponent(contentType.slice(12));
	query += "&message=" + encodeMessageForUrl(message, useBase64);
	const url = request.url + query;
	const header = new Headers(request.header);
	for (const h of [
		headerProtocolVersion,
		headerContentType,
		headerUnaryContentLength,
		headerUnaryEncoding,
		headerUnaryAcceptEncoding
	]) header.delete(h);
	return Object.assign(Object.assign({}, request), {
		requestMethod: "GET",
		url,
		header
	});
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol/run-call.js
/**
* Runs a unary method with the given interceptors. Note that this function
* is only used when implementing a Transport.
*/
function runUnaryCall(opt) {
	const next = applyInterceptors(opt.next, opt.interceptors);
	const [signal, abort, done] = setupSignal(opt);
	return next(Object.assign(Object.assign({}, opt.req), {
		message: normalize(opt.req.method.input, opt.req.message),
		signal
	})).then((res) => {
		done();
		return res;
	}, abort);
}
/**
* Runs a server-streaming method with the given interceptors. Note that this
* function is only used when implementing a Transport.
*/
function runStreamingCall(opt) {
	const next = applyInterceptors(opt.next, opt.interceptors);
	const [signal, abort, done] = setupSignal(opt);
	const req = Object.assign(Object.assign({}, opt.req), {
		message: normalizeIterable(opt.req.method.input, opt.req.message),
		signal
	});
	let doneCalled = false;
	signal.addEventListener("abort", function() {
		var _a, _b;
		const it = opt.req.message[Symbol.asyncIterator]();
		if (!doneCalled) (_a = it.throw) === null || _a === void 0 || _a.call(it, this.reason).catch(() => {});
		(_b = it.return) === null || _b === void 0 || _b.call(it).catch(() => {});
	});
	return next(req).then((res) => {
		return Object.assign(Object.assign({}, res), { message: { [Symbol.asyncIterator]() {
			const it = res.message[Symbol.asyncIterator]();
			return { next() {
				if (!doneCalled && signal.aborted) return abort(getAbortSignalReason(signal));
				return it.next().then((r) => {
					if (r.done == true) {
						doneCalled = true;
						done();
					}
					return r;
				}, abort);
			} };
		} } });
	}, abort);
}
/**
* Create an AbortSignal for Transport implementations. The signal is available
* in UnaryRequest and StreamingRequest, and is triggered when the call is
* aborted (via a timeout or explicit cancellation), errored (e.g. when reading
* an error from the server from the wire), or finished successfully.
*
* Transport implementations can pass the signal to HTTP clients to ensure that
* there are no unused connections leak.
*
* Returns a tuple:
* [0]: The signal, which is also aborted if the optional deadline is reached.
* [1]: Function to call if the Transport encountered an error.
* [2]: Function to call if the Transport finished without an error.
*/
function setupSignal(opt) {
	const { signal, cleanup } = createDeadlineSignal(opt.timeoutMs);
	const controller = createLinkedAbortController(opt.signal, signal);
	return [
		controller.signal,
		function abort(reason) {
			const e = controller.signal.aborted ? ConnectError.from(getAbortSignalReason(controller.signal), Code.Canceled) : ConnectError.from(reason);
			controller.abort(e);
			cleanup();
			return Promise.reject(e);
		},
		function done() {
			cleanup();
			controller.abort();
		}
	];
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol-connect/transport.js
var __asyncValues = function(o) {
	if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
	var m = o[Symbol.asyncIterator], i;
	return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
		return this;
	}, i);
	function verb(n) {
		i[n] = o[n] && function(v) {
			return new Promise(function(resolve, reject) {
				v = o[n](v), settle(resolve, reject, v.done, v.value);
			});
		};
	}
	function settle(resolve, reject, d, v) {
		Promise.resolve(v).then(function(v) {
			resolve({
				value: v,
				done: d
			});
		}, reject);
	}
};
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
/**
* Create a Transport for the Connect protocol.
*/
function createTransport(opt) {
	return {
		async unary(method, signal, timeoutMs, header, message, contextValues) {
			const serialization = createMethodSerializationLookup(method, opt.binaryOptions, opt.jsonOptions, opt);
			timeoutMs = timeoutMs === void 0 ? opt.defaultTimeoutMs : timeoutMs <= 0 ? void 0 : timeoutMs;
			return await runUnaryCall({
				interceptors: opt.interceptors,
				signal,
				timeoutMs,
				req: {
					stream: false,
					service: method.parent,
					method,
					requestMethod: "POST",
					url: createMethodUrl(opt.baseUrl, method),
					header: requestHeaderWithCompression(method.methodKind, opt.useBinaryFormat, timeoutMs, header, opt.acceptCompression, opt.sendCompression, true),
					contextValues: contextValues !== null && contextValues !== void 0 ? contextValues : createContextValues(),
					message
				},
				next: async (req) => {
					let requestBody = serialization.getI(opt.useBinaryFormat).serialize(req.message);
					if (opt.sendCompression && requestBody.byteLength > opt.compressMinBytes) {
						requestBody = await opt.sendCompression.compress(requestBody);
						req.header.set(headerUnaryEncoding, opt.sendCompression.name);
					} else req.header.delete(headerUnaryEncoding);
					const useGet = opt.useHttpGet === true && method.idempotency === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS;
					let body;
					if (useGet) req = transformConnectPostToGetRequest(req, requestBody, opt.useBinaryFormat);
					else body = createAsyncIterable([requestBody]);
					const universalResponse = await opt.httpClient({
						url: req.url,
						method: req.requestMethod,
						header: req.header,
						signal: req.signal,
						body
					});
					const { compression, isUnaryError, unaryError } = validateResponseWithCompression(method.methodKind, opt.acceptCompression, opt.useBinaryFormat, universalResponse.status, universalResponse.header);
					const [header, trailer] = trailerDemux(universalResponse.header);
					let responseBody = await pipeTo(universalResponse.body, sinkAllBytes(opt.readMaxBytes, universalResponse.header.get(headerUnaryContentLength)), { propagateDownStreamError: false });
					if (compression) responseBody = await compression.decompress(responseBody, opt.readMaxBytes);
					if (isUnaryError) throw errorFromJsonBytes(responseBody, appendHeaders(header, trailer), unaryError);
					return {
						stream: false,
						service: method.parent,
						method,
						header,
						message: serialization.getO(opt.useBinaryFormat).parse(responseBody),
						trailer
					};
				}
			});
		},
		async stream(method, signal, timeoutMs, header, input, contextValues) {
			const serialization = createMethodSerializationLookup(method, opt.binaryOptions, opt.jsonOptions, opt);
			const endStreamSerialization = createEndStreamSerialization(opt.jsonOptions);
			timeoutMs = timeoutMs === void 0 ? opt.defaultTimeoutMs : timeoutMs <= 0 ? void 0 : timeoutMs;
			return runStreamingCall({
				interceptors: opt.interceptors,
				signal,
				timeoutMs,
				req: {
					stream: true,
					service: method.parent,
					method,
					requestMethod: "POST",
					url: createMethodUrl(opt.baseUrl, method),
					header: requestHeaderWithCompression(method.methodKind, opt.useBinaryFormat, timeoutMs, header, opt.acceptCompression, opt.sendCompression, true),
					contextValues: contextValues !== null && contextValues !== void 0 ? contextValues : createContextValues(),
					message: input
				},
				next: async (req) => {
					const uRes = await opt.httpClient({
						url: req.url,
						method: "POST",
						header: req.header,
						signal: req.signal,
						body: pipe(req.message, transformSerializeEnvelope(serialization.getI(opt.useBinaryFormat)), transformCompressEnvelope(opt.sendCompression, opt.compressMinBytes), transformJoinEnvelopes(), { propagateDownStreamError: true })
					});
					const { compression } = validateResponseWithCompression(method.methodKind, opt.acceptCompression, opt.useBinaryFormat, uRes.status, uRes.header);
					const res = Object.assign(Object.assign({}, req), {
						header: uRes.header,
						trailer: new Headers(),
						message: pipe(uRes.body, transformSplitEnvelope(opt.readMaxBytes), transformDecompressEnvelope(compression !== null && compression !== void 0 ? compression : null, opt.readMaxBytes), transformParseEnvelope(serialization.getO(opt.useBinaryFormat), 2, endStreamSerialization), function(iterable) {
							return __asyncGenerator(this, arguments, function* () {
								var _a, e_1, _b, _c;
								let endStreamReceived = false;
								try {
									for (var _d = true, iterable_1 = __asyncValues(iterable), iterable_1_1; iterable_1_1 = yield __await(iterable_1.next()), _a = iterable_1_1.done, !_a; _d = true) {
										_c = iterable_1_1.value;
										_d = false;
										const chunk = _c;
										if (chunk.end) {
											if (endStreamReceived) throw new ConnectError("protocol error: received extra EndStreamResponse", Code.InvalidArgument);
											endStreamReceived = true;
											if (chunk.value.error) {
												const error = chunk.value.error;
												uRes.header.forEach((value, key) => {
													error.metadata.append(key, value);
												});
												throw error;
											}
											chunk.value.metadata.forEach((value, key) => res.trailer.set(key, value));
											continue;
										}
										if (endStreamReceived) throw new ConnectError("protocol error: received extra message after EndStreamResponse", Code.InvalidArgument);
										yield yield __await(chunk.value);
									}
								} catch (e_1_1) {
									e_1 = { error: e_1_1 };
								} finally {
									try {
										if (!_d && !_a && (_b = iterable_1.return)) yield __await(_b.call(iterable_1));
									} finally {
										if (e_1) throw e_1.error;
									}
								}
								if (!endStreamReceived) throw new ConnectError("protocol error: missing EndStreamResponse", Code.InvalidArgument);
							});
						}, { propagateDownStreamError: true })
					});
					return res;
				}
			});
		}
	};
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/protocol/universal-handler-client.js
/**
* An in-memory UniversalClientFn that can be used to route requests to a ConnectRouter
* bypassing network calls. Useful for testing and calling in-process services.
*/
function createUniversalHandlerClient(uHandlers) {
	const handlerMap = /* @__PURE__ */ new Map();
	for (const handler of uHandlers) handlerMap.set(handler.requestPath, handler);
	return async (uClientReq) => {
		var _a, _b, _c;
		const pathname = new URL(uClientReq.url).pathname;
		const handler = handlerMap.get(pathname);
		if (!handler) throw new ConnectError(`RouterHttpClient: no handler registered for ${pathname}`, Code.Unimplemented);
		const reqSignal = (_a = uClientReq.signal) !== null && _a !== void 0 ? _a : new AbortController().signal;
		const uServerRes = await raceSignal(reqSignal, handler({
			body: (_b = uClientReq.body) !== null && _b !== void 0 ? _b : createAsyncIterable([]),
			httpVersion: "2.0",
			method: uClientReq.method,
			url: uClientReq.url,
			header: uClientReq.header,
			signal: reqSignal
		}));
		return {
			body: pipe((_c = uServerRes.body) !== null && _c !== void 0 ? _c : createAsyncIterable([]), (iterable) => {
				return { [Symbol.asyncIterator]() {
					const it = iterable[Symbol.asyncIterator]();
					const w = { next() {
						return raceSignal(reqSignal, it.next());
					} };
					if (it.throw !== void 0) w.throw = (e) => it.throw(e);
					if (it.return !== void 0) w.return = (value) => it.return(value);
					return w;
				} };
			}),
			header: new Headers(uServerRes.header),
			status: uServerRes.status,
			trailer: new Headers(uServerRes.trailer)
		};
	};
}
/**
* Wrap a promise, and reject early if the given signal triggers before the
* promise is settled.
*/
function raceSignal(signal, promise) {
	let cleanup;
	const signalPromise = new Promise((_, reject) => {
		const onAbort = () => reject(getAbortSignalReason(signal));
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort);
		cleanup = () => signal.removeEventListener("abort", onAbort);
	});
	return Promise.race([signalPromise, promise]).finally(cleanup);
}
//#endregion
//#region node_modules/@connectrpc/connect/dist/esm/router-transport.js
/**
* Creates a Transport that routes requests to the configured router. Useful for testing
* and calling services running in the same process.
*
* This can be used to test both client logic by using this to stub/mock the backend,
* and to test server logic by using this to run without needing to spin up a server.
*/
function createRouterTransport(routes, options) {
	var _a, _b;
	const router = createConnectRouter(Object.assign(Object.assign({}, (_a = options === null || options === void 0 ? void 0 : options.router) !== null && _a !== void 0 ? _a : {}), { connect: true }));
	routes(router);
	return createTransport(Object.assign({
		httpClient: createUniversalHandlerClient(router.handlers),
		baseUrl: "https://in-memory",
		useBinaryFormat: true,
		interceptors: [],
		acceptCompression: [],
		sendCompression: null,
		compressMinBytes: Number.MAX_SAFE_INTEGER,
		readMaxBytes: Number.MAX_SAFE_INTEGER,
		writeMaxBytes: Number.MAX_SAFE_INTEGER
	}, (_b = options === null || options === void 0 ? void 0 : options.transport) !== null && _b !== void 0 ? _b : {}));
}
//#endregion
export { createContextValues as A, Code as B, headerTimeout$1 as C, createMethodImplSpec as D, createHandlerContext as E, makeAnyClient as F, appendHeaders as I, decodeBinaryHeader as L, createCallbackClient as M, createEnvelopeReadableStream as N, createServiceImplSpec as O, encodeEnvelope as P, encodeBinaryHeader as R, headerGrpcStatus as S, trailerParse as T, fromJson as V, contentTypeProto$1 as _, validateResponse as a, headerContentType$1 as b, createConnectRouter as c, errorFromJson as d, createClientMethodSerializers as f, contentTypeJson$1 as g, findTrailerError as h, transformConnectPostToGetRequest as i, createClient as j, createContextKey as k, trailerDemux as l, createMethodUrl as m, runStreamingCall as n, requestHeader as o, getJsonOptions as p, runUnaryCall as r, cors as s, createRouterTransport as t, endStreamFromJson as u, headerXGrpcWeb as v, headerUserAgent$1 as w, headerGrpcMessage as x, headerXUserAgent as y, ConnectError as z };
