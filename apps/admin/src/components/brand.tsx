import Image from 'next/image';
import Link from 'next/link';

export function Brand() {
  return <Link className="brand" href="/console" prefetch={false} aria-label="pickly console"><Image src="/mark.svg" width={29} height={42} alt="" unoptimized /><span>pickly<span className="brand-caption">CONSOLE</span></span></Link>;
}
