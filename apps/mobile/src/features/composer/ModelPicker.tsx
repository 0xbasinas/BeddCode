import { effortLabel } from '@beddcode/client-runtime'
import type { ModelOption, ProviderInstance } from '@beddcode/contracts'
import { useEffect, useState } from 'react'

import { MenuSheet } from '@/ui/MenuSheet'

/** The efforts a model offers: its own list, else the agent's. */
const effortsOf = (model: ModelOption | undefined, provider: ProviderInstance) =>
  model?.efforts ?? provider.capabilities.efforts ?? []

/**
 * Choosing a model, then (when it has them) a reasoning effort. Both steps are floating menus;
 * `onChange` gets the pair once it is complete. No model means the agent's own default.
 */
export function ModelPicker({
  visible,
  onClose,
  provider,
  modelId,
  effort,
  onChange,
}: {
  visible: boolean
  onClose(): void
  provider: ProviderInstance
  modelId?: string
  effort?: string
  onChange(modelId: string | undefined, effort: string | undefined): void
}) {
  const models = provider.capabilities.models ?? []
  const [pending, setPending] = useState<ModelOption>()
  useEffect(() => {
    if (!visible) setPending(undefined)
  }, [visible])

  const finish = (model: string | undefined, chosen: string | undefined) => {
    onChange(model, chosen)
    onClose()
  }

  const efforts = effortsOf(pending, provider)

  return (
    <>
      <MenuSheet
        visible={visible && !pending}
        title="Model"
        closeOnSelect={false}
        onClose={onClose}
        items={[
          {
            id: 'agent-default',
            label: 'Agent default',
            selected: !modelId,
            onSelect: () => finish(undefined, undefined),
          },
          ...models.map((m) => ({
            id: m.id,
            label: m.label,
            hint: m.description,
            selected: m.id === modelId,
            onSelect: () => {
              const choices = effortsOf(m, provider)
              if (choices.length > 1) setPending(m)
              else finish(m.id, choices[0])
            },
          })),
        ]}
      />
      <MenuSheet
        visible={visible && Boolean(pending)}
        title={pending ? `${pending.label}: how hard should it think?` : 'Effort'}
        closeOnSelect={false}
        onClose={onClose}
        items={efforts.map((e) => ({
          id: e,
          label: effortLabel(e),
          selected: pending?.id === modelId && e === effort,
          onSelect: () => finish(pending?.id, e),
        }))}
      />
    </>
  )
}
