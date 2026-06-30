import { Record } from 'immutable'
import { useSyncExternalStore } from 'react'

type Model = Record<{
  count: number
}>
const init: () => Model = Record({ count: 0 })

type Msg = { kind: 'CountIncrement' }
  | { kind: 'CountDecrement' }

export const update = (msg: Msg, model: Model): Model => {
  switch (msg.kind) {
    case 'CountIncrement': {
      const oldCount = model.get('count');
      return model.set('count', oldCount + 1);
    }
    case 'CountDecrement': {
      const oldCount = model.get('count');
      return model.set('count', oldCount - 1);
    }
    default:
      throw new Error('Unknown message');
  }
}

let model = init()
let subs: Set<() => void> = new Set()
export const send = (msg: Msg) => {
  model = update(msg, model)
  subs.forEach(sub => sub())
}

export const useModel = <A,>(selector: (model: Model) => A) => {
  const value = useSyncExternalStore((onStoreChange) => {
    subs.add(onStoreChange)
    return () => subs.delete(onStoreChange)
  }, () => selector(model))
  return value
}
