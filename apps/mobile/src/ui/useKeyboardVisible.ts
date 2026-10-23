import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'

/** Whether the on-screen keyboard is up, so chrome that belongs at the bottom can step aside. */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setVisible(true),
    )
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setVisible(false),
    )
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  return visible
}
