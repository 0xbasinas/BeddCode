import { X } from 'phosphor-react-native'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, View } from 'react-native'

import { hostHttpBase, hostRequest } from '@/host/store'
import { colors, radius } from '@/theme/tokens'
import { Icon } from '@/ui/Icon'

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|heic)$/i

/** Attachments shown as a picture instead of a chip, judged by name. */
export const isImageName = (name: string) => IMAGE.test(name)

/** The address of an attached image on its host, once the host has issued one. */
function useAttachmentUri(hostKey: string, ref: { id?: string; path?: string }) {
  const [uri, setUri] = useState<string>()
  useEffect(() => {
    let live = true
    hostRequest(hostKey, 'attachments.media', ref).then(
      (m) => {
        const base = hostHttpBase(hostKey)
        if (live && m && base) setUri(`${base}${m.url}`)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [hostKey, ref.id, ref.path])
  return uri
}

/** A thumbnail of an attached image; tap it for the full size. `onRemove` adds an X. */
export function AttachmentImage({
  hostKey,
  name,
  id,
  path,
  size = 56,
  uploading,
  onRemove,
}: {
  hostKey: string
  name: string
  id?: string
  path?: string
  size?: number
  uploading?: boolean
  onRemove?: () => void
}) {
  const uri = useAttachmentUri(hostKey, { id, path })
  const [open, setOpen] = useState(false)
  return (
    <View style={{ paddingTop: onRemove ? 6 : 0, paddingRight: onRemove ? 6 : 0 }}>
      <Pressable
        onPress={() => uri && setOpen(true)}
        accessibilityLabel={`Preview ${name}`}
        style={[styles.thumb, { width: size, height: size, opacity: uploading ? 0.6 : 1 }]}
      >
        {uri ? (
          <Image source={{ uri }} style={{ width: size, height: size }} resizeMode="cover" />
        ) : (
          <ActivityIndicator size="small" color={colors.muted} />
        )}
      </Pressable>
      {onRemove ? (
        <Pressable
          hitSlop={8}
          onPress={onRemove}
          accessibilityLabel={`Remove ${name}`}
          style={styles.remove}
        >
          <Icon icon={X} size={11} />
        </Pressable>
      ) : null}
      {open && uri ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setOpen(false)}>
          <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
            <Image source={{ uri }} style={styles.full} resizeMode="contain" />
            <Pressable
              hitSlop={12}
              onPress={() => setOpen(false)}
              accessibilityLabel="Close preview"
              style={styles.close}
            >
              <Icon icon={X} size={20} color="#fff" />
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  thumb: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.control,
    backgroundColor: colors.card,
  },
  remove: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  full: { width: '86%', height: '60%', borderRadius: radius.control },
  close: { position: 'absolute', top: 54, right: 20 },
})
