; cnc-basic fixture (task 13) - CNC machine mode with a spindle and a touch probe
M453
M584 X0 Y1 Z2
M574 X1 S1
M574 Y1 S1
M574 Z2 S3 K0

M950 R0 C"out0"
M563 P0 R0

M558 K0 C"io0.in" H2 F600
