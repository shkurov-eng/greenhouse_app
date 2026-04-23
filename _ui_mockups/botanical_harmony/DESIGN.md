---
name: Botanical Harmony
colors:
  surface: '#fff8f5'
  surface-dim: '#e2d8d2'
  surface-bright: '#fff8f5'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#fcf2eb'
  surface-container: '#f6ece6'
  surface-container-high: '#f0e6e0'
  surface-container-highest: '#eae1da'
  on-surface: '#1f1b17'
  on-surface-variant: '#3c4a42'
  inverse-surface: '#342f2b'
  inverse-on-surface: '#f9efe8'
  outline: '#6c7a71'
  outline-variant: '#bbcabf'
  surface-tint: '#006c49'
  primary: '#006c49'
  on-primary: '#ffffff'
  primary-container: '#10b981'
  on-primary-container: '#00422b'
  inverse-primary: '#4edea3'
  secondary: '#944a23'
  on-secondary: '#ffffff'
  secondary-container: '#fd9e70'
  on-secondary-container: '#76340e'
  tertiary: '#855300'
  on-tertiary: '#ffffff'
  tertiary-container: '#e29100'
  on-tertiary-container: '#523200'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#6ffbbe'
  primary-fixed-dim: '#4edea3'
  on-primary-fixed: '#002113'
  on-primary-fixed-variant: '#005236'
  secondary-fixed: '#ffdbcc'
  secondary-fixed-dim: '#ffb693'
  on-secondary-fixed: '#351000'
  on-secondary-fixed-variant: '#76330d'
  tertiary-fixed: '#ffddb8'
  tertiary-fixed-dim: '#ffb95f'
  on-tertiary-fixed: '#2a1700'
  on-tertiary-fixed-variant: '#653e00'
  background: '#fff8f5'
  on-background: '#1f1b17'
  surface-variant: '#eae1da'
typography:
  h1:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '700'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  h2:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.3'
    letterSpacing: -0.01em
  h3:
    fontFamily: Plus Jakarta Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: '1.4'
    letterSpacing: '0'
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
    letterSpacing: '0'
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
    letterSpacing: '0'
  label-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: '600'
    lineHeight: '1'
    letterSpacing: 0.05em
  caption:
    fontFamily: Plus Jakarta Sans
    fontSize: 12px
    fontWeight: '500'
    lineHeight: '1.4'
    letterSpacing: '0'
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  gutter: 16px
  margin-mobile: 20px
  margin-desktop: 40px
---

## Brand & Style

The design system is anchored in the concept of "Digital Nurturing." It bridges the gap between structured productivity and organic growth, creating an environment that feels as life-affirming as a sun-drenched sunroom. The target audience includes urban gardeners, busy homeowners, and plant enthusiasts who seek a sense of calm accomplishment rather than high-pressure task management.

The visual style is **Modern Minimalism with Tactile Warmth**. It avoids the sterile coldness of typical productivity apps by utilizing soft tonal layers and organic spacing. The interface acts as a quiet assistant—organized and dependable, yet approachable and warm. Every interaction should evoke a sense of breathing room, utilizing generous white space to prevent information overload.

## Colors

The palette for this design system is inspired by a thriving indoor garden. 

- **Primary (Emerald Green):** Represents vitality and the "Watered/Healthy" state. It is used for primary actions and brand flourishes.
- **Secondary (Cedar Wood):** A deep, warm brown used for grounding elements, iconography, and subtle accents to provide a sense of home and stability.
- **Backgrounds (Stone/Linen):** We use an off-white (#FAFAF9) for the main canvas to reduce eye strain and provide a "homey" feel compared to pure digital white.
- **Status Colors:** These are high-chroma to ensure immediate recognition. 
    - **Green** for "Thriving"
    - **Yellow** for "Needs Attention" (e.g., misting required)
    - **Red** for "Overdue" (e.g., immediate watering needed)

## Typography

This design system utilizes **Plus Jakarta Sans** for its friendly, open counters and modern geometric feel. The typeface strikes a balance between professional clarity and an optimistic, rounded personality.

- **Headlines:** Set with tighter letter spacing and bold weights to create a strong visual anchor for plant species or room names.
- **Body Text:** Uses a generous line height (1.6) to ensure tasks and care instructions are easily scannable while moving around the house.
- **Labels:** Small caps or bold weights are used for metadata, such as "Last Watered" or "Light Level," to distinguish them from actionable task descriptions.

## Layout & Spacing

The layout philosophy follows a **soft fluid grid**. On mobile, we prioritize a single-column view with 20px margins to allow "breathability." On larger screens, the design system transitions to a multi-column card layout to mimic a dashboard or a potting bench.

Spacing is based on a **4px baseline rhythm**. Horizontal gutters are strictly maintained at 16px to ensure that plant cards and task lists feel connected but distinct. Negative space is treated as a design element itself; rather than crowding the screen with data, we use 32px (xl) padding between major functional sections to maintain a calm atmosphere.

## Elevation & Depth

To maintain the fresh and friendly vibe, the design system avoids heavy, dark shadows. Instead, it utilizes **Tonal Layers** and **Ambient Tinted Shadows**.

- **Surface Tiers:** The main background is off-white. Cards and containers sit on top in pure white, creating a subtle contrast.
- **Shadows:** Use a very soft, diffused shadow (Blur: 20px, Y: 4px) with a hint of the secondary wood tone in the shadow color (e.g., 5-8% opacity of the brown) to give a warm, physical presence to the UI.
- **Active States:** When a user interacts with a plant card, the elevation increases slightly through a larger shadow blur, making the element feel as if it is being "lifted" toward the light.

## Shapes

The shape language is defined by organic, approachable curves. The design system uses a standard **roundedness level of 2 (8px - 12px)** to mirror the soft edges of leaves and household furniture.

- **Standard Elements (Buttons/Inputs):** Use 12px corners to feel comfortable and safe to touch.
- **Large Elements (Cards/Modals):** Use 24px (rounded-xl) to create a soft frame for photography of greenery.
- **Interactive Indicators:** Checkboxes and radio buttons should have a slight 4px radius rather than sharp corners to maintain the friendly aesthetic.

## Components

- **Buttons:** Primary buttons use the Emerald Green background with white text. They should have a subtle 2px bottom border in a slightly darker green to feel "pressable."
- **Plant Cards:** These are the heart of the app. They feature a large image area at the top with a 24px corner radius, a "Status Chip" in the top right corner, and a clean wood-toned title at the bottom.
- **Status Chips:** Small, pill-shaped indicators. The background should be a 15% opacity tint of the status color (Green/Yellow/Red) with high-contrast text of the same hue for maximum accessibility.
- **Input Fields:** Use a light grey border (1px) that turns Emerald Green on focus. Labels sit just above the field in the Secondary Wood tone.
- **Progress Rings:** Used for moisture levels. These should use a thick stroke with rounded ends to emphasize the organic nature of the data.
- **Task List Items:** These feature a circular checkbox on the left. When checked, the task text doesn't just strike through—it fades slightly to a warm grey, keeping the screen looking clean and "weeded."