# Ablation comparison

Task ID: QX-R5-002
Source commit: a4965e4a172d48661d6685111e69a44c2b868637

| Variant | Changed hypothesis | Fixed setup | Measurement | Outcome |
| --- | --- | --- | --- | --- |
| Prior minimum | No explicit distance rail | 1920x1080, 15s, 25fps, identical input | Longest low-difference run 33 frames | reference |
| ConveyorRail standard | distanceMm controls Near/Mid/Far and encounters | identical route, viewport, duration, input | flow 100%, median 4.380px; low-diff run 2; passes 592-608ms | chosen |
| ConveyorRail reduced | decorative rotations disabled only | identical route, viewport, duration, input | identical flow/ring/pass/Z; low-diff run 3 | parity retained |
| 2x playback | only playback speed doubled | identical source frames, duration becomes 7.52s | contacts collapse to 2.0/4.0/5.5s | rejected |

The chosen result changes spatial motion control, not merely playback speed, bloom, fog, or camera shake.
