import { LayoutAnimation } from 'react-native'

/** Call just before a state change that opens or closes something, so the rest eases into place. */
export function animateLayout() {
  LayoutAnimation.configureNext(
    LayoutAnimation.create(
      180,
      LayoutAnimation.Types.easeInEaseOut,
      LayoutAnimation.Properties.opacity,
    ),
  )
}
