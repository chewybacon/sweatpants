import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import * as stylex from "@stylexjs/stylex";
import { rosePineTheme, tokens } from "./tokens.stylex.ts";

function mergeClassName(generated: string | undefined, supplied: string | undefined) {
  return [generated, supplied].filter(Boolean).join(" ");
}

const rootStyles = stylex.create({
  root: {
    minHeight: "100vh",
    backgroundColor: tokens.colorBackground,
    color: tokens.colorText,
    fontFamily: tokens.fontBody,
  },
});

export function DesignSystemRoot({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const styles = stylex.props(rootStyles.root, rosePineTheme);
  return (
    <div {...styles} className={mergeClassName(styles.className, className)}>
      {children}
    </div>
  );
}

const stackStyles = stylex.create({
  base: { display: "flex" },
  vertical: { flexDirection: "column" },
  horizontal: { flexDirection: "row" },
  wrap: { flexWrap: "wrap" },
  gap1: { gap: tokens.space1 },
  gap2: { gap: tokens.space2 },
  gap3: { gap: tokens.space3 },
  gap4: { gap: tokens.space4 },
  gap5: { gap: tokens.space5 },
  gap6: { gap: tokens.space6 },
  alignStart: { alignItems: "flex-start" },
  alignCenter: { alignItems: "center" },
  alignEnd: { alignItems: "flex-end" },
  alignStretch: { alignItems: "stretch" },
  justifyStart: { justifyContent: "flex-start" },
  justifyCenter: { justifyContent: "center" },
  justifyEnd: { justifyContent: "flex-end" },
  justifyBetween: { justifyContent: "space-between" },
});

const gaps = {
  1: stackStyles.gap1,
  2: stackStyles.gap2,
  3: stackStyles.gap3,
  4: stackStyles.gap4,
  5: stackStyles.gap5,
  6: stackStyles.gap6,
} as const;
const alignments = {
  start: stackStyles.alignStart,
  center: stackStyles.alignCenter,
  end: stackStyles.alignEnd,
  stretch: stackStyles.alignStretch,
} as const;
const justifications = {
  start: stackStyles.justifyStart,
  center: stackStyles.justifyCenter,
  end: stackStyles.justifyEnd,
  between: stackStyles.justifyBetween,
} as const;

export interface StackProps extends HTMLAttributes<HTMLDivElement> {
  direction?: "vertical" | "horizontal";
  gap?: keyof typeof gaps;
  align?: keyof typeof alignments;
  justify?: keyof typeof justifications;
  wrap?: boolean;
}

export function Stack({
  direction = "vertical",
  gap = 3,
  align = "stretch",
  justify = "start",
  wrap = false,
  className,
  ...props
}: StackProps) {
  const styles = stylex.props(
    stackStyles.base,
    direction === "vertical" ? stackStyles.vertical : stackStyles.horizontal,
    gaps[gap],
    alignments[align],
    justifications[justify],
    wrap && stackStyles.wrap,
  );
  return <div {...props} {...styles} className={mergeClassName(styles.className, className)} />;
}

const headingStyles = stylex.create({
  base: {
    margin: 0,
    color: tokens.colorText,
    fontFamily: tokens.fontDisplay,
    fontWeight: 600,
    lineHeight: 1.08,
    textWrap: "balance",
  },
  display: {
    fontSize: "clamp(3rem, 9vw, 7.5rem)",
    letterSpacing: "-0.065em",
  },
  title: {
    fontSize: "clamp(2.35rem, 6vw, 5.25rem)",
    letterSpacing: "-0.055em",
  },
  section: {
    fontSize: "clamp(1.55rem, 3vw, 2.4rem)",
    letterSpacing: "-0.035em",
  },
  body: {
    fontFamily: tokens.fontBody,
    fontSize: "1.05rem",
    fontWeight: 650,
    letterSpacing: "-0.02em",
    lineHeight: 1.25,
  },
});

export interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  level?: 1 | 2 | 3 | 4;
  size?: "display" | "title" | "section" | "body";
}

export function Heading({ level = 2, size = "section", className, ...props }: HeadingProps) {
  const Element = `h${level}` as const;
  const styles = stylex.props(headingStyles.base, headingStyles[size]);
  return <Element {...props} {...styles} className={mergeClassName(styles.className, className)} />;
}

const cardStyles = stylex.create({
  root: {
    minWidth: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.colorBorder,
    borderRadius: tokens.radiusLarge,
    backgroundColor: tokens.colorSurface,
    color: tokens.colorText,
    boxShadow: tokens.shadowLow,
  },
  muted: { backgroundColor: tokens.colorSurfaceOverlay },
  raised: { backgroundColor: tokens.colorSurfaceRaised, boxShadow: tokens.shadowMedium },
  primary: { backgroundColor: tokens.colorPrimaryContainer, borderColor: tokens.colorPrimary },
  secondary: {
    backgroundColor: tokens.colorSecondaryContainer,
    borderColor: tokens.colorSecondaryText,
  },
  error: { backgroundColor: tokens.colorErrorContainer, borderColor: tokens.colorErrorText },
  warning: { backgroundColor: tokens.colorWarningContainer, borderColor: tokens.colorWarningText },
  p2: { padding: tokens.space2 },
  p3: { padding: tokens.space3 },
  p4: { padding: tokens.space4 },
  p5: { padding: tokens.space5 },
  p6: { padding: tokens.space6 },
  header: { display: "flex", flexDirection: "column", gap: tokens.space2, padding: tokens.space5 },
  content: { paddingInline: tokens.space5, paddingBottom: tokens.space5 },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: tokens.space2,
    paddingInline: tokens.space5,
    paddingBottom: tokens.space5,
  },
  description: { margin: 0, color: tokens.colorTextMuted, fontSize: "0.875rem", lineHeight: 1.55 },
});

const cardTones = {
  default: undefined,
  muted: cardStyles.muted,
  raised: cardStyles.raised,
  primary: cardStyles.primary,
  secondary: cardStyles.secondary,
  error: cardStyles.error,
  warning: cardStyles.warning,
} as const;
const cardPadding = {
  2: cardStyles.p2,
  3: cardStyles.p3,
  4: cardStyles.p4,
  5: cardStyles.p5,
  6: cardStyles.p6,
} as const;

export interface CardRootProps extends HTMLAttributes<HTMLDivElement> {
  tone?: keyof typeof cardTones;
  padding?: keyof typeof cardPadding;
}

const CardRoot = forwardRef<HTMLDivElement, CardRootProps>(function CardRoot(
  { tone = "default", padding, className, ...props },
  ref,
) {
  const styles = stylex.props(cardStyles.root, cardTones[tone], padding && cardPadding[padding]);
  return (
    <div ref={ref} {...props} {...styles} className={mergeClassName(styles.className, className)} />
  );
});

function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const styles = stylex.props(cardStyles.header);
  return <div {...props} {...styles} className={mergeClassName(styles.className, className)} />;
}
function CardTitle(props: HeadingProps) {
  return <Heading level={3} size="body" {...props} />;
}
function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  const styles = stylex.props(cardStyles.description);
  return <p {...props} {...styles} className={mergeClassName(styles.className, className)} />;
}
function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const styles = stylex.props(cardStyles.content);
  return <div {...props} {...styles} className={mergeClassName(styles.className, className)} />;
}
function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const styles = stylex.props(cardStyles.footer);
  return <div {...props} {...styles} className={mergeClassName(styles.className, className)} />;
}

export const Card = {
  Root: CardRoot,
  Header: CardHeader,
  Title: CardTitle,
  Description: CardDescription,
  Content: CardContent,
  Footer: CardFooter,
};

const buttonStyles = stylex.create({
  base: {
    minHeight: tokens.controlMedium,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.space2,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: tokens.radiusSmall,
    paddingInline: tokens.space4,
    color: tokens.colorText,
    fontFamily: tokens.fontBody,
    fontSize: "0.875rem",
    fontWeight: 650,
    lineHeight: 1,
    textDecoration: "none",
    whiteSpace: "nowrap",
    cursor: "pointer",
    transitionProperty: "background-color, border-color, color, box-shadow, transform",
    transitionDuration: "150ms",
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: tokens.colorFocus,
      outlineOffset: "3px",
    },
    ":active": { transform: "translateY(1px)" },
  },
  small: { minHeight: tokens.controlSmall, paddingInline: tokens.space3, fontSize: "0.78rem" },
  large: { minHeight: tokens.controlLarge, paddingInline: tokens.space5, fontSize: "0.95rem" },
  filledPrimary: {
    backgroundColor: tokens.colorPrimaryContainer,
    borderColor: tokens.colorPrimary,
    color: tokens.colorPrimaryText,
    boxShadow: tokens.shadowLow,
    ":hover": { backgroundColor: tokens.colorPrimaryContainerHover },
  },
  filledSecondary: {
    backgroundColor: tokens.colorSecondaryContainer,
    borderColor: tokens.colorSecondaryText,
    color: tokens.colorSecondaryText,
    ":hover": { backgroundColor: tokens.colorSecondaryContainerHover },
  },
  filledDanger: {
    backgroundColor: tokens.colorErrorContainer,
    borderColor: tokens.colorErrorText,
    color: tokens.colorErrorText,
    ":hover": { backgroundColor: tokens.colorErrorContainerHover },
  },
  outline: {
    backgroundColor: "transparent",
    borderColor: tokens.colorBorderStrong,
    color: tokens.colorText,
    ":hover": { backgroundColor: tokens.colorOverlayHover, borderColor: tokens.colorTextMuted },
  },
  ghost: {
    backgroundColor: "transparent",
    borderColor: "transparent",
    color: tokens.colorTextMuted,
    ":hover": { backgroundColor: tokens.colorOverlayHover, color: tokens.colorText },
  },
  disabled: {
    backgroundColor: tokens.colorOverlayDisabled,
    borderColor: "transparent",
    color: tokens.colorTextMuted,
    boxShadow: "none",
    cursor: "not-allowed",
    opacity: 0.58,
    ":hover": { backgroundColor: tokens.colorOverlayDisabled },
    ":active": { transform: "none" },
  },
});

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
  variant?: "filled" | "outline" | "ghost";
  color?: "primary" | "secondary" | "danger";
  size?: "sm" | "md" | "lg";
  href?: string;
}

export function Button({
  variant = "filled",
  color = "primary",
  size = "md",
  href,
  disabled = false,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  const filled =
    color === "primary"
      ? buttonStyles.filledPrimary
      : color === "secondary"
        ? buttonStyles.filledSecondary
        : buttonStyles.filledDanger;
  const styles = stylex.props(
    buttonStyles.base,
    size === "sm" && buttonStyles.small,
    size === "lg" && buttonStyles.large,
    variant === "filled"
      ? filled
      : variant === "outline"
        ? buttonStyles.outline
        : buttonStyles.ghost,
    disabled && buttonStyles.disabled,
  );
  const mergedClassName = mergeClassName(styles.className, className);
  if (href) {
    const anchorProps = props as AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <a
        {...anchorProps}
        {...styles}
        className={mergedClassName}
        href={disabled ? undefined : href}
        aria-disabled={disabled || undefined}
      >
        {children}
      </a>
    );
  }
  return (
    <button {...props} {...styles} className={mergedClassName} type={type} disabled={disabled}>
      {children}
    </button>
  );
}

const badgeStyles = stylex.create({
  base: {
    width: "fit-content",
    display: "inline-flex",
    alignItems: "center",
    minHeight: "22px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.colorBorder,
    borderRadius: tokens.radiusPill,
    paddingInline: tokens.space2,
    color: tokens.colorTextMuted,
    backgroundColor: tokens.colorSurfaceOverlay,
    fontFamily: tokens.fontBody,
    fontSize: "0.65rem",
    fontWeight: 750,
    letterSpacing: "0.085em",
    lineHeight: 1,
    textTransform: "uppercase",
  },
  primary: {
    color: tokens.colorPrimaryText,
    borderColor: tokens.colorPrimary,
    backgroundColor: tokens.colorPrimaryContainer,
  },
  secondary: {
    color: tokens.colorSecondaryText,
    borderColor: tokens.colorSecondaryText,
    backgroundColor: tokens.colorSecondaryContainer,
  },
  error: {
    color: tokens.colorErrorText,
    borderColor: tokens.colorErrorText,
    backgroundColor: tokens.colorErrorContainer,
  },
  warning: {
    color: tokens.colorWarningText,
    borderColor: tokens.colorWarningText,
    backgroundColor: tokens.colorWarningContainer,
  },
  success: {
    color: tokens.colorSuccessText,
    borderColor: tokens.colorSuccessText,
    backgroundColor: tokens.colorSuccessContainer,
  },
});
const badgeTones = {
  neutral: undefined,
  primary: badgeStyles.primary,
  secondary: badgeStyles.secondary,
  error: badgeStyles.error,
  warning: badgeStyles.warning,
  success: badgeStyles.success,
} as const;

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: keyof typeof badgeTones;
}
export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  const styles = stylex.props(badgeStyles.base, badgeTones[tone]);
  return <span {...props} {...styles} className={mergeClassName(styles.className, className)} />;
}

const linkStyles = stylex.create({
  root: {
    color: tokens.colorPrimaryText,
    fontWeight: 650,
    textDecoration: "none",
    textUnderlineOffset: "3px",
    ":hover": { color: tokens.colorSecondaryText, textDecoration: "underline" },
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: tokens.colorFocus,
      outlineOffset: "3px",
    },
  },
});
export function Link({ className, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const styles = stylex.props(linkStyles.root);
  return <a {...props} {...styles} className={mergeClassName(styles.className, className)} />;
}

const fieldStyles = stylex.create({
  field: { display: "flex", flexDirection: "column", gap: tokens.space2 },
  label: { color: tokens.colorText, fontSize: "0.8rem", fontWeight: 650 },
  control: {
    width: "100%",
    boxSizing: "border-box",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.colorBorderStrong,
    borderRadius: tokens.radiusMedium,
    backgroundColor: tokens.colorSurfaceOverlay,
    color: tokens.colorText,
    fontFamily: tokens.fontBody,
    fontSize: "0.95rem",
    lineHeight: 1.55,
    padding: tokens.space3,
    transitionProperty: "background-color, border-color, box-shadow",
    transitionDuration: "150ms",
    "::placeholder": { color: tokens.colorTextMuted },
    ":hover": { borderColor: tokens.colorTextMuted },
    ":focus": {
      borderColor: tokens.colorPrimaryText,
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: tokens.colorFocus,
      outlineOffset: "2px",
    },
    ":disabled": {
      backgroundColor: tokens.colorOverlayDisabled,
      color: tokens.colorTextMuted,
      cursor: "not-allowed",
      opacity: 0.62,
    },
  },
  textarea: { minHeight: "112px", resize: "vertical" },
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  onValueChange?: (value: string) => void;
}
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, id, className, onValueChange, onChange, ...props },
  ref,
) {
  const controlId = id ?? `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const field = stylex.props(fieldStyles.field);
  const labelStyle = stylex.props(fieldStyles.label);
  const control = stylex.props(fieldStyles.control, fieldStyles.textarea);
  return (
    <label {...field} htmlFor={controlId}>
      <span {...labelStyle}>{label}</span>
      <textarea
        ref={ref}
        {...props}
        {...control}
        id={controlId}
        className={mergeClassName(control.className, className)}
        onChange={(event) => {
          onChange?.(event);
          onValueChange?.(event.currentTarget.value);
        }}
      />
    </label>
  );
});

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  onValueChange?: (value: string) => void;
}
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { label, id, className, onValueChange, onChange, ...props },
  ref,
) {
  const controlId = id ?? `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const field = stylex.props(fieldStyles.field);
  const labelStyle = stylex.props(fieldStyles.label);
  const control = stylex.props(fieldStyles.control);
  return (
    <label {...field} htmlFor={controlId}>
      <span {...labelStyle}>{label}</span>
      <input
        ref={ref}
        {...props}
        {...control}
        id={controlId}
        className={mergeClassName(control.className, className)}
        onChange={(event) => {
          onChange?.(event);
          onValueChange?.(event.currentTarget.value);
        }}
      />
    </label>
  );
});
