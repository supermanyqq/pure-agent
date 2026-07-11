const INPUT_INSTANCE_INCREMENT = 1;

/** Returns a new TextInput key only after a programmatic command completion. */
export function getNextInputInstanceKey(currentKey: number, completed: boolean): number {
  return completed ? currentKey + INPUT_INSTANCE_INCREMENT : currentKey;
}
