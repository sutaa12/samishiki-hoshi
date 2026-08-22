export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();

  const freeze = (candidate: unknown): void => {
    if ((typeof candidate !== "object" && typeof candidate !== "function") || candidate === null) return;
    const object = candidate as object;
    if (seen.has(object)) return;
    seen.add(object);

    for (const key of Reflect.ownKeys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && "value" in descriptor) freeze(descriptor.value);
    }
    Object.freeze(object);
  };

  freeze(value);
  return value;
}
